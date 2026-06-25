// ── Types ─────────────────────────────────────────────────────────────────────

export interface Card {
  suit: string;
  value: string;
  hidden: boolean;
  magic?: boolean;
  _numVal?: number;
}

export interface TrumpCard {
  id: string;
  name: string;
  emoji: string;
  type: 'self' | 'targeted' | 'global';
  desc: string;
}

export interface PlayerState {
  userId: number;
  username: string;
  hand: Card[];
  trumps: TrumpCard[];
  stood: boolean;
  busted: boolean;
  bless: boolean;
  shield: boolean;
  lastTrump: TrumpCard | null;
  result: 'win' | 'lose' | 'draw' | null;
  wins: number;
  connected: boolean;
}

export interface PlayerView {
  userId: number;
  username: string;
  hand: Array<{ suit: string; value: string; hidden: boolean; magic?: boolean }>;
  myTrumps: TrumpCard[];
  trumpCount: number;
  stood: boolean;
  busted: boolean;
  bless: boolean;
  shield: boolean;
  result: PlayerState['result'];
  wins: number;
  connected: boolean;
  score: number;
}

export type GamePhase = 'lobby' | 'playing' | 'dealerTurn' | 'roundOver';
export type GameMode  = 'vsDealer' | 'vsPlayers';

export interface RoomState {
  roomCode: string;
  hostUserId: number;
  phase: GamePhase;
  mode: GameMode;
  target: number;
  round: number;
  curIdx: number;
  players: PlayerState[];
  dealer: PlayerState | null;
  deck: Card[];
  log: string[];
}

export interface ClientView {
  roomCode: string;
  hostUserId: number;
  phase: GamePhase;
  mode: GameMode;
  target: number;
  round: number;
  curIdx: number;
  myUserId: number;
  players: PlayerView[];
  dealer?: PlayerView;
  log: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SUITS  = ['♠', '♥', '♦', '♣'] as const;
const VALUES = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'] as const;

export const TRUMPS: TrumpCard[] = [
  { id:'2card',      name:'2-Card',      emoji:'2️⃣', type:'self',     desc:'Add a 2 to your hand' },
  { id:'3card',      name:'3-Card',      emoji:'3️⃣', type:'self',     desc:'Add a 3 to your hand' },
  { id:'4card',      name:'4-Card',      emoji:'4️⃣', type:'self',     desc:'Add a 4 to your hand' },
  { id:'5card',      name:'5-Card',      emoji:'5️⃣', type:'self',     desc:'Add a 5 to your hand' },
  { id:'6card',      name:'6-Card',      emoji:'6️⃣', type:'self',     desc:'Add a 6 to your hand' },
  { id:'7card',      name:'7-Card',      emoji:'7️⃣', type:'self',     desc:'Add a 7 to your hand' },
  { id:'goFor17',    name:'Go For 17',   emoji:'🎯', type:'global',   desc:'Change target to 17 for everyone' },
  { id:'goFor24',    name:'Go For 24',   emoji:'🎯', type:'global',   desc:'Change target to 24 for everyone' },
  { id:'goFor27',    name:'Go For 27',   emoji:'🎯', type:'global',   desc:'Change target to 27 for everyone' },
  { id:'hush',       name:'Hush',        emoji:'🤫', type:'self',     desc:'Draw a card face-down (hidden from others)' },
  { id:'perfect',    name:'Perfect',     emoji:'✨', type:'self',     desc:'Drop cards until your score hits the target' },
  { id:'remove',     name:'Remove',      emoji:'✂️', type:'targeted', desc:"Remove opponent's last drawn card" },
  { id:'exchange',   name:'Exchange',    emoji:'🔄', type:'targeted', desc:"Swap your last card with opponent's" },
  { id:'disservice', name:'Disservice',  emoji:'😈', type:'targeted', desc:'Force opponent to draw a card' },
  { id:'destroy',    name:'Destroy',     emoji:'💥', type:'targeted', desc:"Destroy opponent's last trump" },
  { id:'bless',      name:'Bless',       emoji:'🙏', type:'self',     desc:'Survive one bust this round' },
  { id:'shield',     name:'Shield',      emoji:'🛡️', type:'self',     desc:'Block next targeted trump against you' },
];

// ── Deck helpers ──────────────────────────────────────────────────────────────

export function makeDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (const v of VALUES) d.push({ suit: s, value: v, hidden: false });
  return d;
}

export function shuffle<T>(a: T[]): T[] {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function pickTrumps(n: number): TrumpCard[] {
  return shuffle(TRUMPS).slice(0, n).map(t => ({ ...t }));
}

export function randomSuit(): string {
  return SUITS[Math.floor(Math.random() * 4)];
}

export function magicCard(val: number): Card {
  return { suit: '✨', value: String(val), hidden: false, magic: true, _numVal: val };
}

export function calcScore(hand: Card[], target: number): number {
  let score = 0, aces = 0;
  for (const c of hand) {
    if (c.hidden) continue;
    if (c.magic && c._numVal !== undefined) { score += c._numVal; continue; }
    if (c.value === 'A') { aces++; score += 11; }
    else if (['J', 'Q', 'K'].includes(c.value)) score += 10;
    else score += parseInt(c.value);
  }
  while (score > target && aces > 0) { score -= 10; aces--; }
  return score;
}

// ── View builder (per-player privacy filter) ──────────────────────────────────

export function buildView(state: RoomState, myUserId: number): ClientView {
  const revealDealer = state.phase === 'dealerTurn' || state.phase === 'roundOver';
  return {
    roomCode:    state.roomCode,
    hostUserId:  state.hostUserId,
    phase:       state.phase,
    mode:        state.mode,
    target:      state.target,
    round:       state.round,
    curIdx:      state.curIdx,
    myUserId,
    players: state.players.map(p => playerView(p, myUserId, state.target)),
    dealer:  state.dealer ? dealerView(state.dealer, revealDealer, state.target) : undefined,
    log:     state.log.slice(0, 20),
  };
}

function playerView(p: PlayerState, myId: number, target: number): PlayerView {
  const isMe = p.userId === myId;
  return {
    userId:   p.userId,
    username: p.username,
    hand: p.hand.map(c => ({
      suit:   c.suit,
      value:  (c.hidden && !isMe) ? '?' : c.value,
      hidden: c.hidden && !isMe,
      magic:  c.magic,
    })),
    myTrumps:  isMe ? p.trumps : [],
    trumpCount: p.trumps.length,
    stood:   p.stood,
    busted:  p.busted,
    bless:   p.bless,
    shield:  p.shield,
    result:  p.result,
    wins:    p.wins,
    connected: p.connected,
    score: calcScore(isMe ? p.hand : p.hand.filter(c => !c.hidden), target),
  };
}

function dealerView(d: PlayerState, reveal: boolean, target: number): PlayerView {
  return {
    userId:   0,
    username: 'Dealer',
    hand: d.hand.map(c => ({
      suit:   c.suit,
      value:  (c.hidden && !reveal) ? '?' : c.value,
      hidden: c.hidden && !reveal,
    })),
    myTrumps:  [],
    trumpCount: 0,
    stood:   d.stood,
    busted:  d.busted,
    bless:   false,
    shield:  false,
    result:  d.result,
    wins:    0,
    connected: true,
    score: calcScore(reveal ? d.hand : d.hand.filter(c => !c.hidden), target),
  };
}
