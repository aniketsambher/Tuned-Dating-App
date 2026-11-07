import { artist, persona } from "./helpers";

const phoebe = artist("phoebe-bridgers", ["indie folk", "indie pop"]);
const bigThief = artist("big-thief", ["indie folk"]);
const mitski = artist("mitski", ["indie pop", "art pop"]);
const boygenius = artist("boygenius", ["indie folk"]);
const japaneseBreakfast = artist("japanese-breakfast", ["indie pop"]);
const snailMail = artist("snail-mail", ["indie rock", "indie pop"]);
const radiohead = artist("radiohead", ["alternative rock", "art rock"]);
const bjork = artist("bjork", ["art pop"]);
const tameImpala = artist("tame-impala", ["psychedelic rock"]);
const milesDavis = artist("miles-davis", ["jazz", "bebop"]);
const coltrane = artist("john-coltrane", ["jazz"]);

/** Indie folk/pop fan. The reference user in most tests. */
export const alice = persona("alice", "Alice", [phoebe, bigThief, mitski, boygenius, japaneseBreakfast]);
/** Nearly the same taste as Alice. */
export const bob = persona("bob", "Bob", [bigThief, phoebe, mitski, snailMail, boygenius]);
/** One shared artist (Mitski) and an overlapping genre (art pop). */
export const carol = persona("carol", "Carol", [radiohead, bjork, mitski, tameImpala]);
/** Jazz only: nothing in common with Alice. */
export const dave = persona("dave", "Dave", [milesDavis, coltrane]);

export const everyone = [alice, bob, carol, dave];
