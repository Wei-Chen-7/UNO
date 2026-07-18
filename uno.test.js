#!/usr/bin/env node
/* Test harness for the UNO engine embedded in index.html.
   Usage: node uno.test.js
   - Extracts the pure engine from the <script id="uno-engine"> block.
   - Runs deterministic scenario tests for each core rule/flow.
   - Fuzzes 1000 full random matches, asserting on every engine call:
       * no crashes
       * the 108 cards are always conserved (exact id multiset)
       * every match terminates */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/<script id="uno-engine">([\s\S]*?)<\/script>/);
if (!m) { console.error('FATAL: engine script block not found in index.html'); process.exit(1); }
const ctx = { console, module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(m[1], ctx);
const U = ctx.UNO;
if (!U || typeof U.newMatch !== 'function') { console.error('FATAL: UNO engine failed to load'); process.exit(1); }

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(msg);
  if (failures.length <= 25) console.error('  FAIL:', msg);
  return false;
}
function section(name) { console.log('· ' + name); }

/* ---------- invariants ---------- */

function totalCards(st) {
  let n = st.draw.length + st.discard.length;
  for (const p of st.players) n += p.hand.length;
  return n;
}
function idsExact(st) {
  const seen = new Set();
  const scan = (arr) => { for (const c of arr) { if (seen.has(c.id)) return false; seen.add(c.id); } return true; };
  if (!scan(st.draw) || !scan(st.discard)) return false;
  for (const p of st.players) if (!scan(p.hand)) return false;
  return seen.size === 108;
}
function checkInv(st, tag) {
  const t = totalCards(st);
  if (t !== 108) return ok(false, `cards total ${t} != 108 @ ${tag}`);
  if (!idsExact(st)) return ok(false, `duplicate/missing card ids @ ${tag}`);
  pass += 2;
  return true;
}

/* ---------- helpers for crafting states (conservation-safe) ---------- */

function grab(st, pred) {
  for (let i = st.draw.length - 1; i >= 0; i--)
    if (pred(st.draw[i])) return st.draw.splice(i, 1)[0];
  throw new Error('grab: card not found in draw pile');
}
function give(st, p, pred) { const c = grab(st, pred); st.players[p].hand.push(c); return c; }
function clearHand(st, p) { while (st.players[p].hand.length) st.draw.unshift(st.players[p].hand.pop()); }
/* return every hand and the whole discard to the draw pile, then set a fresh top */
function resetAll(st) {
  for (const p of st.players) while (p.hand.length) st.draw.push(p.hand.pop());
  while (st.discard.length) st.draw.push(st.discard.pop());
}
function setTop(st, pred, color) {
  const c = grab(st, pred);
  st.discard.push(c);
  st.color = color || c.color;
  return c;
}
const isNum = (col, val) => (c) => c.kind === 'num' && c.color === col && (val == null || c.value === val);
const isKind = (kind, col) => (c) => c.kind === kind && (col == null || c.color === col);

function freshState(opts) { return U.newMatch(Object.assign({ seed: 42 }, opts)); }

/* ---------- scenario tests ---------- */

section('deck composition');
{
  const d = U.makeDeck();
  ok(d.length === 108, 'deck has 108 cards');
  const count = (pred) => d.filter(pred).length;
  for (const c of ['R', 'Y', 'G', 'B']) {
    ok(count(isNum(c, 0)) === 1, `one ${c}0`);
    for (let v = 1; v <= 9; v++) ok(count(isNum(c, v)) === 2, `two ${c}${v}`);
    ok(count(isKind('skip', c)) === 2, `two ${c} skips`);
    ok(count(isKind('rev', c)) === 2, `two ${c} reverses`);
    ok(count(isKind('d2', c)) === 2, `two ${c} +2s`);
  }
  ok(count((c) => c.kind === 'wild') === 4, 'four wilds');
  ok(count((c) => c.kind === 'w4') === 4, 'four wild+4s');
  ok(new Set(d.map(c => c.id)).size === 108, 'unique ids');
  ok(U.cardPoints({ kind: 'num', value: 7 }) === 7 &&
     U.cardPoints({ kind: 'skip' }) === 20 &&
     U.cardPoints({ kind: 'rev' }) === 20 &&
     U.cardPoints({ kind: 'd2' }) === 20 &&
     U.cardPoints({ kind: 'wild' }) === 50 &&
     U.cardPoints({ kind: 'w4' }) === 50, 'card point values');
}

section('deal: 7 cards each, valid start card');
{
  for (let seed = 0; seed < 300; seed++) {
    const st = U.newMatch({ seed, bots: 1 + (seed % 3) });
    const top = st.discard[st.discard.length - 1];
    const bonus = top.kind === 'd2' ? 2 : 0; // a +2 start card hits the first player
    st.players.forEach((p, i) => {
      const want = 7 + (i === 0 ? bonus : 0);
      if (p.hand.length !== want) ok(false, `player ${i} dealt ${p.hand.length}, want ${want} @ seed ${seed}`);
    });
    if (top.kind === 'wild' || top.kind === 'w4') ok(false, `wild start card @ seed ${seed}`);
    if (!checkInv(st, 'deal seed ' + seed)) break;
  }
  ok(true, 'deal sweep done');
}

section('start card actions apply');
{
  let sawSkip = 0, sawRev = 0, sawD2 = 0, sawNum = 0;
  for (let seed = 0; seed < 4000 && !(sawSkip && sawRev && sawD2 && sawNum); seed++) {
    const st = U.newMatch({ seed, bots: 3 });
    const top = st.discard[0];
    const n = st.players.length;
    if (top.kind === 'skip' && !sawSkip) {
      sawSkip = 1;
      ok(st.cur === 1, 'skip start: first player skipped');
    } else if (top.kind === 'rev' && !sawRev) {
      sawRev = 1;
      ok(st.dir === -1 && st.cur === n - 1, 'reverse start: direction flipped, last player first');
    } else if (top.kind === 'd2' && !sawD2) {
      sawD2 = 1;
      ok(st.players[0].hand.length === 9 && st.cur === 1, 'draw-two start: player 0 drew 2 and is skipped');
      checkInv(st, 'd2 start');
    } else if (top.kind === 'num' && !sawNum) {
      sawNum = 1;
      ok(st.cur === 0 && st.color === top.color, 'number start: player 0 begins, color set');
    }
  }
  ok(sawSkip && sawRev && sawD2 && sawNum, 'found all four start-card kinds');
}

section('flow: play a number card');
{
  const st = freshState({ bots: 3 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 5));
  clearHand(st, 0);
  give(st, 0, isNum('R', 9));  // matches color
  give(st, 0, isNum('G', 5));  // matches number
  give(st, 0, isNum('B', 7));  // matches nothing
  give(st, 0, isKind('wild')); // always
  const legal = U.playableIdxs(st, 0);
  ok(legal.join(',') === '0,1,3', `legal plays = [0,1,3], got [${legal}]`);
  const evs = U.playCard(st, 0, 1, null); // play G5
  ok(st.color === 'G', 'color follows played card');
  ok(st.discard[st.discard.length - 1].value === 5, 'top card updated');
  ok(st.cur === 1, 'turn advanced');
  ok(evs.some(e => e.t === 'play'), 'play event emitted');
  ok(st.players[0].hand.length === 3, 'hand shrank');
  checkInv(st, 'number play');
  let threw = false;
  try { U.playCard(st, 0, 0, null); } catch (e) { threw = true; }
  ok(threw, 'playing out of turn throws');
}

section('flow: hit by Draw Two (no stacking)');
{
  const st = freshState({ bots: 3 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 3));
  clearHand(st, 0);
  give(st, 0, isKind('d2', 'R'));
  give(st, 0, isNum('R', 1));
  const before = st.players[1].hand.length;
  U.playCard(st, 0, 0, null);
  ok(st.players[1].hand.length === before + 2, 'victim drew 2');
  ok(st.cur === 2, 'victim lost their turn');
  ok(st.pending === 0, 'pending cleared');
  checkInv(st, 'd2');
}

section('flow: +2 stacking house rule');
{
  const st = freshState({ bots: 3, stack: true });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 3));
  clearHand(st, 0); clearHand(st, 1); clearHand(st, 2);
  give(st, 0, isKind('d2', 'R'));
  give(st, 0, isNum('B', 8));
  give(st, 1, isKind('d2', 'G'));
  give(st, 1, isNum('Y', 2));
  give(st, 2, isNum('Y', 4));
  give(st, 2, isNum('Y', 5));
  U.playCard(st, 0, 0, null);
  ok(st.pending === 2 && st.cur === 1, 'pending 2, victim may stack');
  const legal = U.playableIdxs(st, 1);
  ok(legal.length === 1 && st.players[1].hand[legal[0]].kind === 'd2', 'only +2 is stackable');
  U.playCard(st, 1, legal[0], null);
  ok(st.pending === 0, 'stack resolved on non-holder');
  ok(st.players[2].hand.length === 2 + 4, 'third player drew accumulated 4');
  ok(st.cur === 3, 'third player skipped');
  checkInv(st, 'stacking');

  // taking instead of stacking
  const st2 = freshState({ bots: 3, stack: true, seed: 43 });
  st2.cur = 0; st2.dir = 1; st2.phase = 'play';
  resetAll(st2); setTop(st2, isNum('R', 3));
  clearHand(st2, 0); clearHand(st2, 1);
  give(st2, 0, isKind('d2', 'R'));
  give(st2, 0, isNum('B', 8));
  give(st2, 1, isKind('d2', 'Y'));
  give(st2, 1, isNum('G', 2));
  U.playCard(st2, 0, 0, null);
  ok(st2.pending === 2 && st2.cur === 1, 'victim has stack choice');
  U.takePending(st2, 1);
  ok(st2.players[1].hand.length === 4 && st2.pending === 0 && st2.cur === 2, 'took 2, turn passed');
  checkInv(st2, 'take pending');
}

section('flow: wild color choice');
{
  const st = freshState({ bots: 3 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 3));
  clearHand(st, 0);
  give(st, 0, isKind('wild'));
  give(st, 0, isNum('B', 8));
  let threw = false;
  try { U.playCard(st, 0, 0, null); } catch (e) { threw = true; }
  ok(threw, 'wild without color throws');
  const evs = U.playCard(st, 0, 0, 'G');
  ok(st.color === 'G', 'chosen color active');
  ok(evs.some(e => e.t === 'color' && e.color === 'G'), 'color event emitted');
  ok(st.cur === 1, 'wild advances one');
  checkInv(st, 'wild');
}

section('flow: Wild Draw Four');
{
  const st = freshState({ bots: 3 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 3));
  clearHand(st, 0);
  give(st, 0, isKind('w4'));
  give(st, 0, isNum('B', 8));
  const before = st.players[1].hand.length;
  U.playCard(st, 0, 0, 'B');
  ok(st.color === 'B', 'w4 sets color');
  ok(st.players[1].hand.length === before + 4, 'victim drew 4');
  ok(st.cur === 2, 'victim skipped');
  checkInv(st, 'w4');
}

section('flow: skip and reverse');
{
  const st = freshState({ bots: 3 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 3));
  clearHand(st, 0);
  give(st, 0, isKind('skip', 'R'));
  give(st, 0, isKind('rev', 'R'));
  give(st, 0, isNum('B', 8));
  U.playCard(st, 0, 0, null);
  ok(st.cur === 2, 'skip jumps one player');
  st.cur = 0; st.phase = 'play';
  U.playCard(st, 0, 0, null); // reverse (idx 0 now the rev)
  ok(st.dir === -1 && st.cur === 3, 'reverse flips direction; previous player next');
  checkInv(st, 'skip/rev');
}

section('flow: reverse acts as skip with 2 players');
{
  const st = freshState({ bots: 1 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 3));
  clearHand(st, 0);
  give(st, 0, isKind('rev', 'R'));
  give(st, 0, isNum('B', 8));
  U.playCard(st, 0, 0, null);
  ok(st.cur === 0, 'two-player reverse: same player goes again');
  checkInv(st, '2p reverse');
}

section('flow: draw pile reshuffle');
{
  const st = freshState({ bots: 3 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  // Move the entire draw pile onto the discard (under a known top).
  resetAll(st); setTop(st, isNum('R', 5));
  clearHand(st, 0);
  give(st, 0, isNum('B', 8)); // not playable vs R5
  while (st.draw.length) st.discard.unshift(st.draw.pop());
  ok(st.draw.length === 0, 'draw pile emptied');
  const discardBefore = st.discard.length;
  const evs = U.drawOne(st, 0);
  ok(evs.some(e => e.t === 'reshuffle'), 'reshuffle event emitted');
  ok(st.discard.length === 1, 'discard reduced to just the top card');
  ok(st.discard[0].kind === 'num' && st.discard[0].value === 5 && st.discard[0].color === 'R',
     'top card preserved through reshuffle');
  ok(st.draw.length === discardBefore - 1 - 1, 'rest of discard became the draw pile (minus 1 drawn)');
  checkInv(st, 'reshuffle');
}

section('flow: draw exhausted (no cards anywhere)');
{
  const st = freshState({ bots: 1 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 5));
  clearHand(st, 0); clearHand(st, 1);
  give(st, 0, isNum('B', 8));
  // move ALL remaining draw cards into bot's hand: nothing anywhere to draw
  while (st.draw.length) st.players[1].hand.push(st.draw.pop());
  const evs = U.drawOne(st, 0);
  ok(evs.some(e => e.t === 'exhausted'), 'exhausted event emitted');
  ok(st.cur === 1, 'turn passes without a draw');
  checkInv(st, 'exhausted');
}

section('flow: draw one, may play it or keep it');
{
  const st = freshState({ bots: 3 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 5));
  clearHand(st, 0);
  give(st, 0, isNum('B', 8));
  // rig next draw to be playable (R7)
  const r7 = grab(st, isNum('R', 7));
  st.draw.push(r7);
  const evs = U.drawOne(st, 0);
  ok(st.phase === 'drawnChoice', 'playable drawn card offers a choice');
  ok(evs.some(e => e.t === 'drawnPlayable'), 'drawnPlayable event');
  const legal = U.playableIdxs(st, 0);
  ok(legal.length === 1 && st.players[0].hand[legal[0]].id === r7.id, 'only drawn card is playable');
  U.playCard(st, 0, st.drawnIdx, null);
  ok(st.discard[st.discard.length - 1].id === r7.id, 'drawn card played immediately');
  checkInv(st, 'drawn play');

  // keep path
  const st2 = freshState({ bots: 3, seed: 7 });
  st2.cur = 0; st2.dir = 1; st2.phase = 'play';
  resetAll(st2); setTop(st2, isNum('R', 5));
  clearHand(st2, 0);
  give(st2, 0, isNum('B', 8));
  st2.draw.push(grab(st2, isNum('R', 6)));
  U.drawOne(st2, 0);
  ok(st2.phase === 'drawnChoice', 'choice offered');
  U.passDraw(st2, 0);
  ok(st2.cur === 1 && st2.players[0].hand.length === 2, 'kept card, turn passed');
  checkInv(st2, 'drawn keep');

  // unplayable draw just passes
  const st3 = freshState({ bots: 3, seed: 8 });
  st3.cur = 0; st3.dir = 1; st3.phase = 'play';
  resetAll(st3); setTop(st3, isNum('R', 5));
  clearHand(st3, 0);
  give(st3, 0, isNum('B', 8));
  st3.draw.push(grab(st3, isNum('G', 2)));
  const e3 = U.drawOne(st3, 0);
  ok(e3.some(e => e.t === 'pass') && st3.cur === 1, 'unplayable draw passes turn');
}

section('flow: draw-until-playable house rule');
{
  const st = freshState({ bots: 3, drawToMatch: true });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 5));
  clearHand(st, 0);
  give(st, 0, isNum('B', 8));
  // rig: top of draw = G2, B9, then R7 -> should draw 3 and stop on R7
  const r7 = grab(st, isNum('R', 7));
  const b9 = grab(st, isNum('B', 9));
  const g2 = grab(st, isNum('G', 2));
  st.draw.push(r7, b9, g2); // pop order: g2, b9, r7
  U.drawOne(st, 0);
  ok(st.phase === 'drawnChoice', 'stopped on playable card');
  ok(st.players[0].hand.length === 4, 'drew exactly until playable (3 cards)');
  ok(st.players[0].hand[st.drawnIdx].id === r7.id, 'stopped on the R7');
  checkInv(st, 'drawToMatch');
}

section('flow: UNO call and catch');
{
  // forget to call -> caught -> +2
  const st = freshState({ bots: 3 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 5));
  clearHand(st, 0);
  give(st, 0, isNum('R', 9));
  give(st, 0, isNum('B', 8));
  U.playCard(st, 0, 0, null);
  ok(st.unoOpen && st.unoOpen.p === 0, 'window open after forgetting UNO');
  const evs = U.catchUno(st, 1, 0);
  ok(evs.some(e => e.t === 'caught'), 'catch event');
  ok(st.players[0].hand.length === 3, 'penalty: drew 2');
  ok(!st.unoOpen, 'window closed');
  checkInv(st, 'uno caught');

  // pre-call protects
  const st2 = freshState({ bots: 3, seed: 44 });
  st2.cur = 0; st2.dir = 1; st2.phase = 'play';
  resetAll(st2); setTop(st2, isNum('R', 5));
  clearHand(st2, 0);
  give(st2, 0, isNum('R', 9));
  give(st2, 0, isNum('B', 8));
  U.callUno(st2, 0);
  ok(st2.players[0].said, 'pre-call registered at 2 cards');
  U.playCard(st2, 0, 0, null);
  ok(!st2.unoOpen, 'no window when UNO was called');
  ok(U.catchUno(st2, 1, 0).length === 0, 'catch fails after call');
  ok(st2.players[0].hand.length === 1, 'no penalty');

  // late call inside the window also protects
  const st3 = freshState({ bots: 3, seed: 45 });
  st3.cur = 0; st3.dir = 1; st3.phase = 'play';
  resetAll(st3); setTop(st3, isNum('R', 5));
  clearHand(st3, 0);
  give(st3, 0, isNum('R', 9));
  give(st3, 0, isNum('B', 8));
  U.playCard(st3, 0, 0, null);
  ok(st3.unoOpen && st3.unoOpen.p === 0, 'window open');
  U.callUno(st3, 0);
  ok(st3.players[0].said && !st3.unoOpen, 'late call closes window');
  ok(U.catchUno(st3, 1, 0).length === 0, 'catch fails after late call');

  // window closes when the next player acts
  const st4 = freshState({ bots: 3, seed: 46 });
  st4.cur = 0; st4.dir = 1; st4.phase = 'play';
  resetAll(st4); setTop(st4, isNum('R', 5));
  clearHand(st4, 0);
  give(st4, 0, isNum('R', 9));
  give(st4, 0, isNum('B', 8));
  clearHand(st4, 1);
  give(st4, 1, isNum('R', 4));
  give(st4, 1, isNum('G', 2)); // extra cards so player 1's play neither wins
  give(st4, 1, isNum('G', 3)); // nor opens player 1's own UNO window
  U.playCard(st4, 0, 0, null);
  ok(st4.unoOpen && st4.unoOpen.p === 0, 'window open');
  U.playCard(st4, 1, 0, null);
  ok(!st4.unoOpen, 'window closed by next player acting');
  ok(U.catchUno(st4, 2, 0).length === 0, 'too late to catch');
}

section('flow: round scoring');
{
  const st = freshState({ bots: 2, seed: 50 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 5));
  clearHand(st, 0); clearHand(st, 1); clearHand(st, 2);
  give(st, 0, isNum('R', 9));            // will be played -> win
  give(st, 1, isNum('Y', 7));            // 7
  give(st, 1, isKind('skip', 'G'));      // 20
  give(st, 2, isKind('w4'));             // 50
  give(st, 2, isNum('B', 0));            // 0
  const evs = U.playCard(st, 0, 0, null);
  const re = evs.find(e => e.t === 'roundEnd');
  ok(!!re, 'roundEnd event');
  ok(re && re.points === 77, `scored 7+20+50+0 = 77 (got ${re && re.points})`);
  ok(st.players[0].score === 77, 'winner credited');
  ok(st.phase === 'roundOver', 'match continues below 500');
  ok(st.players[0].hand.length === 0, 'winner hand empty');
  checkInv(st, 'scoring');

  // crossing 500 ends the match
  const st2 = freshState({ bots: 1, seed: 51 });
  st2.players[0].score = 495;
  st2.cur = 0; st2.dir = 1; st2.phase = 'play';
  resetAll(st2); setTop(st2, isNum('R', 5));
  clearHand(st2, 0); clearHand(st2, 1);
  give(st2, 0, isNum('R', 9));
  give(st2, 1, isNum('Y', 7));
  U.playCard(st2, 0, 0, null);
  ok(st2.phase === 'matchOver' && st2.matchWinner === 0, 'match over at 500+');

  // single-round mode ends immediately
  const st3 = freshState({ bots: 1, single: true, seed: 52 });
  st3.cur = 0; st3.dir = 1; st3.phase = 'play';
  resetAll(st3); setTop(st3, isNum('R', 5));
  clearHand(st3, 0);
  give(st3, 0, isNum('R', 9));
  U.playCard(st3, 0, 0, null);
  ok(st3.phase === 'matchOver', 'single round = match over');

  // winning with a +2 still makes the victim draw (counts in score)
  const st4 = freshState({ bots: 1, seed: 53 });
  st4.cur = 0; st4.dir = 1; st4.phase = 'play';
  resetAll(st4); setTop(st4, isNum('R', 5));
  clearHand(st4, 0); clearHand(st4, 1);
  give(st4, 0, isKind('d2', 'R'));
  give(st4, 1, isNum('Y', 7));
  const e4 = U.playCard(st4, 0, 0, null);
  ok(st4.players[1].hand.length === 3, 'victim drew 2 even on winning play');
  const re4 = e4.find(e => e.t === 'roundEnd');
  const expect = st4.players[1].hand.reduce((s, c) => s + U.cardPoints(c), 0);
  ok(re4 && re4.points === expect, 'score includes penalty draws');
  checkInv(st4, 'win with d2');
}

section('flow: next round rotates and redeals');
{
  const st = freshState({ bots: 2, seed: 60 });
  st.cur = 0; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 5));
  clearHand(st, 0);
  give(st, 0, isNum('R', 9));
  U.playCard(st, 0, 0, null);
  ok(st.phase === 'roundOver', 'round over');
  const evs = U.nextRound(st);
  ok(st.round === 2, 'round counter advanced');
  ok(evs.some(e => e.t === 'start'), 'start event for new round');
  for (const p of st.players) ok(p.hand.length >= 7, 'redealt (7 + possible start +2)');
  checkInv(st, 'next round');
}

section('bot AI behavior');
{
  // saves Wild+4 when other plays exist
  const st = freshState({ bots: 3, seed: 70 });
  st.cur = 1; st.dir = 1; st.phase = 'play';
  resetAll(st); setTop(st, isNum('R', 5));
  clearHand(st, 1);
  give(st, 1, isKind('w4'));
  give(st, 1, isNum('R', 3));
  give(st, 1, isNum('R', 8));
  give(st, 1, isNum('G', 2));
  give(st, 1, isNum('G', 7)); // hand not low for anyone
  const mv = U.botMove(st, 1);
  ok(mv.type === 'play' && st.players[1].hand[mv.idx].kind !== 'w4', 'bot saves w4 when it has another play');

  // plays w4 when it is the only option
  clearHand(st, 1);
  give(st, 1, isKind('w4'));
  give(st, 1, isNum('B', 2));
  const mv2 = U.botMove(st, 1);
  ok(mv2.type === 'play' && st.players[1].hand[mv2.idx].kind === 'w4' && 'RYGB'.includes(mv2.color),
     'bot plays w4 as last resort with a color');

  // wild color = most-held color
  const hand = [];
  const st2 = freshState({ bots: 1, seed: 71 });
  resetAll(st2);
  hand.push(grab(st2, isNum('G', 1)), grab(st2, isNum('G', 2)), grab(st2, isNum('G', 3)), grab(st2, isNum('R', 4)));
  ok(U.botPickColor(hand, st2.rng) === 'G', 'bot picks most-held color');

  // attacks when next player is low
  const st3 = freshState({ bots: 3, seed: 72 });
  st3.cur = 1; st3.dir = 1; st3.phase = 'play';
  resetAll(st3); setTop(st3, isNum('R', 5));
  clearHand(st3, 1); clearHand(st3, 2);
  give(st3, 1, isKind('d2', 'R'));
  give(st3, 1, isNum('R', 3));
  give(st3, 2, isNum('Y', 9)); // next player has 1 card
  const mv3 = U.botMove(st3, 1);
  ok(mv3.type === 'play' && st3.players[1].hand[mv3.idx].kind === 'd2', 'bot attacks low next player with +2');

  // holds actions when next player is comfortable
  const st4 = freshState({ bots: 3, seed: 73 });
  st4.cur = 1; st4.dir = 1; st4.phase = 'play';
  resetAll(st4); setTop(st4, isNum('R', 5));
  give(st4, 1, isKind('d2', 'R'));
  give(st4, 1, isNum('R', 3));
  // next player must be comfortable (>2 cards) for the bot to hold its +2
  give(st4, 2, isNum('Y', 1)); give(st4, 2, isNum('Y', 2));
  give(st4, 2, isNum('Y', 3)); give(st4, 2, isNum('Y', 4));
  const mv4 = U.botMove(st4, 1);
  ok(mv4.type === 'play' && st4.players[1].hand[mv4.idx].kind === 'num', 'bot holds +2 when next player is fine');
}

/* ---------- fuzz: 1000 full random matches ---------- */

section('fuzz: 1000 random matches (invariants on every action)');
{
  const CAP = 60000;
  let totalSteps = 0, totalRounds = 0, crashed = 0;
  for (let g = 0; g < 1000; g++) {
    const rng = U.mulberry32((g * 2654435761) >>> 0);
    const opts = {
      seed: g,
      bots: 1 + Math.floor(rng() * 3),
      stack: rng() < 0.5,
      drawToMatch: rng() < 0.5,
      single: rng() < 0.3,
      target: rng() < 0.5 ? 200 : 500
    };
    let st;
    try {
      st = U.newMatch(opts);
      checkInv(st, `deal g${g}`);
      let steps = 0;
      while (st.phase !== 'matchOver' && steps < CAP) {
        steps++;
        if (st.phase === 'roundOver') {
          U.nextRound(st);
          totalRounds++;
          checkInv(st, `nextRound g${g}`);
          continue;
        }
        const p = st.cur;
        let evs = [];
        if (st.players[p].isBot) {
          const mv = U.botMove(st, p);
          if (mv.type === 'draw') {
            evs = U.drawOne(st, p);
            if (st.phase === 'drawnChoice' && st.cur === p) {
              const mv2 = U.botMove(st, p);
              evs = evs.concat(U.playCard(st, p, mv2.idx, mv2.color));
            }
          } else if (mv.type === 'take') {
            evs = U.takePending(st, p);
          } else {
            evs = U.playCard(st, p, mv.idx, mv.color);
          }
          const pl = st.players[p];
          if (st.phase !== 'roundOver' && st.phase !== 'matchOver' &&
              pl.hand.length === 1 && !pl.said && rng() < 0.8) {
            U.callUno(st, p); // bots usually remember, sometimes forget
          }
        } else {
          // random-ish human
          if (st.phase === 'drawnChoice') {
            if (rng() < 0.6) {
              const c = st.players[0].hand[st.drawnIdx];
              const col = (c.kind === 'wild' || c.kind === 'w4') ? 'RYGB'[Math.floor(rng() * 4)] : null;
              evs = U.playCard(st, 0, st.drawnIdx, col);
            } else evs = U.passDraw(st, 0);
          } else {
            if (st.players[0].hand.length === 2 && rng() < 0.4) U.callUno(st, 0);
            const legal = U.playableIdxs(st, 0);
            if (st.pending > 0) {
              if (legal.length && rng() < 0.7) {
                const i = legal[Math.floor(rng() * legal.length)];
                evs = U.playCard(st, 0, i, null);
              } else evs = U.takePending(st, 0);
            } else if (legal.length && rng() < 0.85) {
              const i = legal[Math.floor(rng() * legal.length)];
              const c = st.players[0].hand[i];
              const col = (c.kind === 'wild' || c.kind === 'w4') ? 'RYGB'[Math.floor(rng() * 4)] : null;
              evs = U.playCard(st, 0, i, col);
            } else {
              evs = U.drawOne(st, 0);
            }
          }
        }
        // random UNO catching / late calls
        if (st.unoOpen && rng() < 0.5) {
          const t = st.unoOpen.p;
          if (t === 0 && rng() < 0.4) U.callUno(st, 0);
          else U.catchUno(st, (t + 1) % st.players.length, t);
        }
        // round-end consistency
        const re = evs.find(e => e.t === 'roundEnd');
        if (re) {
          totalRounds++;
          if (st.players[re.winner].hand.length !== 0) ok(false, `winner hand not empty g${g}`);
          let expect = 0;
          for (let i = 0; i < st.players.length; i++)
            if (i !== re.winner)
              for (const c of st.players[i].hand) expect += U.cardPoints(c);
          if (re.points !== expect) ok(false, `score mismatch g${g}: ${re.points} != ${expect}`);
        }
        if (!checkInv(st, `g${g} step${steps}`)) break;
      }
      totalSteps += steps;
      ok(st.phase === 'matchOver', `game g${g} terminated (${steps} steps)`);
      ok(st.matchWinner != null && st.players[st.matchWinner].score >= (st.rules.target || 1) ||
         st.rules.target === 0, `winner valid g${g}`);
    } catch (err) {
      crashed++;
      ok(false, `CRASH g${g}: ${err.message}\n${err.stack}`);
      if (crashed > 3) break;
    }
  }
  console.log(`  1000 matches, ${totalRounds} rounds, ${totalSteps} actions, ${crashed} crashes`);
}

/* ---------- summary ---------- */

console.log('');
if (fail === 0) {
  console.log(`ALL TESTS PASSED  (${pass} assertions)`);
  process.exit(0);
} else {
  console.log(`FAILED: ${fail} of ${pass + fail} assertions` +
    (failures.length > 25 ? ` (first 25 shown)` : ''));
  process.exit(1);
}
