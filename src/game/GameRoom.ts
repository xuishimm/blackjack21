import {
  PlayerState, RoomState, Card, TrumpCard,
  makeDeck, shuffle, pickTrumps, calcScore, buildView,
  randomSuit, magicCard,
} from './engine';

interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace;
}

export class GameRoom implements DurableObject {
  private ctx: DurableObjectState;
  private env: Env;
  private room: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomState>('room')) ?? null;
    });
  }

  // ── HTTP / WS entry ─────────────────────────────────────────────────────────

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get('Upgrade') === 'websocket') {
      return this.handleWS(req);
    }

    if (req.method === 'POST' && url.pathname.endsWith('/init')) {
      const { code, mode, hostUserId } = await req.json<{ code: string; mode: string; hostUserId: number }>();
      this.room = {
        roomCode:    code,
        hostUserId,
        phase:       'lobby',
        mode:        mode as RoomState['mode'],
        target:      21,
        round:       1,
        curIdx:      0,
        players:     [],
        dealer:      null,
        deck:        shuffle(makeDeck()),
        log:         [],
      };
      await this.persist();
      return new Response('OK');
    }

    return new Response('Not found', { status: 404 });
  }

  private handleWS(req: Request): Response {
    const userId   = parseInt(req.headers.get('X-User-Id') ?? '0');
    const username = req.headers.get('X-Username') ?? 'Unknown';

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [String(userId)]);
    server.serializeAttachment({ userId, username });

    this.joinPlayer(userId, username);
    try { server.send(JSON.stringify({ type: 'yourId', userId })); } catch {}
    this.broadcast();
    this.persist();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernation handlers ────────────────────────────────────────────────────

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (!this.room) return;
    const { userId } = ws.deserializeAttachment() as { userId: number };
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer)); }
    catch { return; }
    this.dispatch(userId, msg);
    this.persist();
  }

  webSocketClose(ws: WebSocket): void {
    const { userId } = ws.deserializeAttachment() as { userId: number };
    if (!this.room) return;
    const p = this.room.players.find(p => p.userId === userId);
    if (p) { p.connected = false; this.broadcast(); this.persist(); }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    if (this.room?.phase === 'dealerTurn') {
      this.dealerStep();
      await this.persist();
    }
  }

  // ── Player join / reconnect ─────────────────────────────────────────────────

  private joinPlayer(userId: number, username: string): void {
    if (!this.room) return;
    const existing = this.room.players.find(p => p.userId === userId);
    if (existing) {
      existing.connected = true;
      existing.username  = username;
      this.addLog(`${username} reconnected`);
    } else if (this.room.phase === 'lobby') {
      this.room.players.push({
        userId, username,
        hand: [], trumps: [], stood: false, busted: false,
        bless: false, shield: false, lastTrump: null,
        result: null, wins: 0, connected: true,
      });
      this.addLog(`${username} joined`);
    }
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  private dispatch(userId: number, msg: Record<string, unknown>): void {
    switch (msg['type']) {
      case 'setMode':   return this.handleSetMode(userId, msg['mode'] as string);
      case 'startGame': return this.handleStart(userId);
      case 'hit':       return this.handleHit(userId);
      case 'stand':     return this.handleStand(userId);
      case 'playTrump': return this.handlePlayTrump(userId, msg['trumpId'] as string, msg['targetUserId'] as number | undefined);
      case 'nextRound': return this.handleNextRound(userId);
    }
  }

  // ── Lobby ───────────────────────────────────────────────────────────────────

  private handleSetMode(userId: number, mode: string): void {
    if (!this.room || this.room.phase !== 'lobby' || this.room.hostUserId !== userId) return;
    this.room.mode = mode as GameMode;
    this.broadcast();
  }

  private handleStart(userId: number): void {
    if (!this.room || this.room.phase !== 'lobby') return;
    if (this.room.hostUserId !== userId || this.room.players.length < 1) return;
    this.beginRound();
  }

  // ── Round lifecycle ─────────────────────────────────────────────────────────

  private beginRound(): void {
    if (!this.room) return;
    this.room.phase  = 'playing';
    this.room.target = 21;
    this.room.curIdx = 0;
    this.room.deck   = shuffle(makeDeck());
    this.room.log    = [];

    for (const p of this.room.players) {
      p.hand = []; p.trumps = pickTrumps(2);
      p.stood = false; p.busted = false;
      p.bless = false; p.shield = false;
      p.lastTrump = null; p.result = null;
    }

    if (this.room.mode === 'vsDealer') {
      this.room.dealer = {
        userId: 0, username: 'Dealer',
        hand: [], trumps: [], stood: false, busted: false,
        bless: false, shield: false, lastTrump: null,
        result: null, wins: 0, connected: true,
      };
    } else {
      this.room.dealer = null;
    }

    // Deal 2 cards each; dealer's second card is face-down
    for (let r = 0; r < 2; r++) {
      for (const p of this.room.players) p.hand.push(this.draw());
      if (this.room.dealer) {
        const c = this.draw();
        if (r === 1) c.hidden = true;
        this.room.dealer.hand.push(c);
      }
    }

    this.addLog(`Round ${this.room.round} started`);
    this.checkBlackjacks();

    // If the first player was auto-stood by blackjack, advance immediately
    const first = this.room.players[this.room.curIdx];
    if (first?.stood || first?.busted) {
      this.broadcast();
      this.advance();
    } else {
      this.broadcast();
    }
  }

  private checkBlackjacks(): void {
    if (!this.room) return;
    for (const p of this.room.players) {
      if (!p.stood && !p.busted && p.hand.length === 2 && calcScore(p.hand, this.room.target) === this.room.target) {
        p.stood = true;
        this.addLog(`${p.username} has Blackjack! 🃏`);
      }
    }
  }

  // ── Turn actions ────────────────────────────────────────────────────────────

  private cur(): PlayerState | null {
    return this.room?.players[this.room.curIdx] ?? null;
  }

  private handleHit(userId: number): void {
    if (!this.room || this.room.phase !== 'playing') return;
    const p = this.cur();
    if (!p || p.userId !== userId || p.stood || p.busted) return;

    const c = this.draw();
    p.hand.push(c);
    const sc = calcScore(p.hand, this.room.target);
    this.addLog(`${p.username} hits → ${c.value}${c.suit} (${sc})`);

    if (sc > this.room.target) {
      this.bust(p);
    } else if (sc === this.room.target) {
      this.addLog(`${p.username} hits exactly ${this.room.target}! ✨`);
      p.stood = true;
      this.broadcast();
      this.advance();
    } else {
      this.broadcast();
    }
  }

  private handleStand(userId: number): void {
    if (!this.room || this.room.phase !== 'playing') return;
    const p = this.cur();
    if (!p || p.userId !== userId || p.stood || p.busted) return;
    this.addLog(`${p.username} stands at ${calcScore(p.hand, this.room.target)}`);
    p.stood = true;
    this.broadcast();
    this.advance();
  }

  private bust(p: PlayerState): void {
    if (!this.room) return;
    if (p.bless) {
      p.bless = false;
      this.addLog(`${p.username} busted — Bless saves them! 🙏`);
      this.broadcast();
      return;
    }
    p.busted = true;
    this.addLog(`${p.username} busted! 💥`);
    this.broadcast();
    this.advance();
  }

  private advance(): void {
    if (!this.room) return;
    let next = this.room.curIdx + 1;
    while (next < this.room.players.length &&
           (this.room.players[next].stood || this.room.players[next].busted)) next++;

    if (next >= this.room.players.length) {
      if (this.room.mode === 'vsDealer') this.startDealer();
      else this.resolveRound();
      return;
    }

    this.room.curIdx = next;
    const np = this.room.players[next];
    // Auto-stand on exact target
    if (!np.stood && calcScore(np.hand, this.room.target) === this.room.target) {
      np.stood = true;
      this.addLog(`${np.username} has ${this.room.target} exactly! 🃏`);
      this.broadcast();
      this.advance();
      return;
    }
    this.broadcast();
  }

  // ── Trump cards ─────────────────────────────────────────────────────────────

  private handlePlayTrump(userId: number, trumpId: string, targetUserId?: number): void {
    if (!this.room || this.room.phase !== 'playing') return;
    const p = this.cur();
    if (!p || p.userId !== userId || p.stood || p.busted) return;

    const tIdx = p.trumps.findIndex(t => t.id === trumpId);
    if (tIdx === -1) return;
    const trump = p.trumps[tIdx];

    let target: PlayerState | null = null;
    if (trump.type === 'targeted') {
      if (targetUserId === undefined) return;
      target = (targetUserId === 0 && this.room.dealer)
        ? this.room.dealer
        : (this.room.players.find(pl => pl.userId === targetUserId && !pl.busted) ?? null);
      if (!target) return;
    }

    p.trumps.splice(tIdx, 1);

    if (target?.shield) {
      target.shield = false;
      this.addLog(`${target.username}'s Shield blocks ${trump.name}! 🛡️`);
      this.broadcast();
      return;
    }

    this.applyTrump(p, target, trump);
  }

  private applyTrump(player: PlayerState, target: PlayerState | null, trump: TrumpCard): void {
    if (!this.room) return;
    this.addLog(`${player.username} plays ${trump.emoji} ${trump.name}`);
    player.lastTrump = trump;

    switch (trump.id) {
      case '2card': case '3card': case '4card':
      case '5card': case '6card': case '7card': {
        const n = parseInt(trump.id);
        player.hand.push({ suit: randomSuit(), value: String(n), hidden: false });
        const sc = calcScore(player.hand, this.room.target);
        if (sc > this.room.target) { this.bust(player); return; }
        if (sc === this.room.target) {
          this.addLog(`${player.username} hits exactly ${this.room.target}! ✨`);
          player.stood = true;
          this.broadcast();
          this.advance();
          return;
        }
        break;
      }

      case 'goFor17': case 'goFor24': case 'goFor27': {
        const prev = this.room.target;
        this.room.target = parseInt(trump.id.replace('goFor', ''));
        this.addLog(`Target changed: ${prev} → ${this.room.target} 🎯`);
        // Check all active players against new target
        for (const p of this.room.players) {
          if (!p.busted && !p.stood && calcScore(p.hand, this.room.target) > this.room.target) {
            this.bust(p);
          }
        }
        this.broadcast();
        return;
      }

      case 'hush':
        player.hand.push(this.draw(true));
        this.addLog(`${player.username} draws a hidden card 🤫`);
        break;

      case 'perfect': {
        const tgt = this.room.target;
        let cur = calcScore(player.hand, tgt);
        // Remove most recently drawn cards until at/below target
        while (cur > tgt && player.hand.length > 2) {
          player.hand.pop();
          cur = calcScore(player.hand, tgt);
        }
        if (cur > tgt) {
          // Edge case: only 2 cards and still over (e.g. A+K on target 17)
          this.bust(player);
          return;
        }
        if (cur < tgt) {
          player.hand.push(magicCard(tgt - cur));
        }
        this.addLog(`${player.username} reaches exactly ${tgt}! ✨`);
        player.stood = true;
        this.broadcast();
        this.advance();
        return;
      }

      case 'remove':
        if (target && target.hand.length) {
          const rem = target.hand.pop()!;
          this.addLog(`Removed ${target.username}'s ${rem.hidden ? '?' : rem.value + rem.suit}`);
          if (target.busted && calcScore(target.hand, this.room.target) <= this.room.target) {
            target.busted = false;
            this.addLog(`${target.username} is back in the game!`);
          }
        }
        break;

      case 'exchange':
        if (target && player.hand.length && target.hand.length) {
          const mine   = player.hand.pop()!;
          const theirs = target.hand.pop()!;
          player.hand.push(theirs);
          target.hand.push(mine);
          this.addLog(`${player.username} swapped cards with ${target.username} 🔄`);
          if (calcScore(player.hand, this.room.target) > this.room.target && !player.busted) {
            this.bust(player); return;
          }
          if (target.userId !== 0 && calcScore(target.hand, this.room.target) > this.room.target && !target.busted) {
            const tp = this.room.players.find(p => p.userId === target!.userId);
            if (tp) { this.bust(tp); return; }
          }
        }
        break;

      case 'disservice':
        if (target) {
          const c = this.draw();
          target.hand.push(c);
          this.addLog(`${target.username} forced to draw ${c.value}${c.suit}! 😈`);
          if (target.userId !== 0 && calcScore(target.hand, this.room.target) > this.room.target && !target.busted) {
            const tp = this.room.players.find(p => p.userId === target!.userId);
            if (tp) { this.bust(tp); return; }
          }
        }
        break;

      case 'destroy':
        if (target?.lastTrump) {
          this.addLog(`${player.username} destroys ${target.username}'s ${target.lastTrump.name}! 💥`);
          target.lastTrump = null;
        } else {
          this.addLog(`Nothing to destroy on ${target?.username ?? '?'}`);
        }
        break;

      case 'bless':
        player.bless = true;
        this.addLog(`${player.username} is Blessed — survives one bust 🙏`);
        break;

      case 'shield':
        player.shield = true;
        this.addLog(`${player.username} raises their Shield 🛡️`);
        break;
    }

    this.broadcast();
  }

  // ── Dealer AI (stepped via DO alarm) ────────────────────────────────────────

  private startDealer(): void {
    if (!this.room?.dealer) return;
    this.room.phase  = 'dealerTurn';
    this.room.curIdx = -1;
    for (const c of this.room.dealer.hand) c.hidden = false;

    const dealerScore = calcScore(this.room.dealer.hand, this.room.target);
    this.addLog(`Dealer reveals — ${dealerScore}`);

    if (this.room.players.every(p => p.busted)) {
      this.addLog('All players busted — dealer wins');
      this.room.dealer.stood = true;
      this.resolveRound();
      return;
    }

    this.broadcast();
    this.ctx.storage.setAlarm(Date.now() + 900);
  }

  private dealerStep(): void {
    if (!this.room?.dealer) return;
    const sc = calcScore(this.room.dealer.hand, this.room.target);
    if (sc <= 16) {
      const c = this.draw();
      this.room.dealer.hand.push(c);
      const nsc = calcScore(this.room.dealer.hand, this.room.target);
      this.addLog(`Dealer hits → ${c.value}${c.suit} (${nsc})`);
      if (nsc > this.room.target) {
        this.room.dealer.busted = true;
        this.addLog('Dealer busts! 💥');
        this.resolveRound();
      } else {
        this.broadcast();
        this.ctx.storage.setAlarm(Date.now() + 900);
      }
    } else {
      this.addLog(`Dealer stands at ${sc}`);
      this.room.dealer.stood = true;
      this.resolveRound();
    }
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  private resolveRound(): void {
    if (!this.room) return;
    this.room.phase = 'roundOver';

    if (this.room.mode === 'vsDealer') {
      const ds = this.room.dealer!.busted ? -1 : calcScore(this.room.dealer!.hand, this.room.target);
      for (const p of this.room.players) {
        const ps = calcScore(p.hand, this.room.target);
        if (p.busted || ps > this.room.target) {
          p.result = 'lose';
        } else if (ds < 0 || ps > ds) {
          p.result = 'win'; p.wins++;
        } else if (ps === ds) {
          p.result = 'draw';
        } else {
          p.result = 'lose';
        }
        this.addLog(`${p.username}: ${this.rl(p.result)} (${ps} vs ${ds < 0 ? 'bust' : ds})`);
      }
    } else {
      const room   = this.room;
      const active = room.players.filter(p => !p.busted && calcScore(p.hand, room.target) <= room.target);
      if (!active.length) {
        room.players.forEach(p => { p.result = 'lose'; });
        this.addLog('Everyone busted!');
      } else {
        const best    = Math.max(...active.map(p => calcScore(p.hand, room.target)));
        const winners = active.filter(p => calcScore(p.hand, room.target) === best);
        for (const p of this.room.players) {
          if (p.busted || calcScore(p.hand, this.room.target) > this.room.target) {
            p.result = 'lose';
          } else if (winners.includes(p)) {
            p.result = winners.length === 1 ? 'win' : 'draw';
            if (winners.length === 1) p.wins++;
          } else {
            p.result = 'lose';
          }
          this.addLog(`${p.username}: ${this.rl(p.result)} (${calcScore(p.hand, this.room.target)})`);
        }
      }
    }

    this.broadcast();
  }

  private rl(r: PlayerState['result']): string {
    return r === 'win' ? '🏆 Win' : r === 'draw' ? '🤝 Draw' : '❌ Lose';
  }

  private handleNextRound(userId: number): void {
    if (!this.room || this.room.phase !== 'roundOver') return;
    if (this.room.hostUserId !== userId) return;
    this.room.round++;
    this.beginRound();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private draw(hidden = false): Card {
    if (!this.room) throw new Error('no room');
    if (!this.room.deck.length) this.room.deck = shuffle(makeDeck());
    return { ...this.room.deck.pop()!, hidden };
  }

  private addLog(msg: string): void {
    if (!this.room) return;
    this.room.log.unshift(msg);
    if (this.room.log.length > 60) this.room.log.length = 60;
  }

  private broadcast(): void {
    if (!this.room) return;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const { userId } = ws.deserializeAttachment() as { userId: number };
        ws.send(JSON.stringify({ type: 'state', data: buildView(this.room, userId) }));
      } catch { /* disconnected socket */ }
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('room', this.room);
  }
}

type GameMode = 'vsDealer' | 'vsPlayers';
