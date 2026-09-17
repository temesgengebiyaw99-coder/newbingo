const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const ALLOWED_ORIGIN = 'https://temesgengebiyaw99-coder.github.io';
const STAKE = 10;
const TOTAL_CARDS = 400;
const SELECTION_TIME = 30;
const CALL_INTERVAL_MS = 4000;
const LETTERS = ['B', 'I', 'N', 'G', 'O'];

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.get('/', (req, res) => res.send('Server Running'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] }
});

// ---------- Card generation ----------
// Shape MUST match the client's getCellNumber()/renderer: { b:[5], i:[5], n:[5], g:[5], o:[5] }
function genCard() {
  const ranges = { b: [1, 15], i: [16, 30], n: [31, 45], g: [46, 60], o: [61, 75] };
  const card = {};
  for (const [col, [lo, hi]] of Object.entries(ranges)) {
    const nums = [];
    while (nums.length < 5) {
      const n = lo + Math.floor(Math.random() * (hi - lo + 1));
      if (!nums.includes(n)) nums.push(n);
    }
    card[col] = nums;
  }
  return card;
}

const allCards = Array.from({ length: TOTAL_CARDS }, genCard);

// Mirrors the client's getCellNumber() mapping exactly, so server-side win
// validation checks the same cells the player actually sees marked.
function cardToGrid(card) {
  const grid = [];
  for (let row = 0; row < 5; row++) {
    const r = [];
    for (let col = 0; col < 5; col++) {
      if (row === 2 && col === 2) { r.push('FREE'); continue; }
      if (col === 0) r.push(card.b[row]);
      else if (col === 1) r.push(card.i[row]);
      else if (col === 2) r.push(row < 2 ? card.n[row] : card.n[row - 1]);
      else if (col === 3) r.push(card.g[row]);
      else r.push(card.o[row]);
    }
    grid.push(r);
  }
  return grid;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Player store (by telegram_id) ----------
const players = new Map();
const socketToTelegramId = new Map();

function getOrCreatePlayer(data) {
  const id = data.telegram_id;
  if (!players.has(id)) {
    players.set(id, {
      wallet: 10,
      xp: 0,
      level: 'Beginner',
      name: data.name || 'Player',
      username: data.username || '',
      imageUrl: data.image_url || '',
      dailyXP: 0,
      cpMsIdx: 0,
      cpClaimed: false
    });
  } else {
    const p = players.get(id);
    p.name = data.name || p.name;
    p.imageUrl = data.image_url || p.imageUrl;
  }
  return players.get(id);
}

// ---------- Game state (single global room) ----------
function freshState() {
  return {
    phase: 'waiting',
    countdown: SELECTION_TIME,
    takenCards: {},
    paidThisRound: new Set(),
    calledNumbers: [],
    remainingPool: shuffle(Array.from({ length: 75 }, (_, i) => i + 1)),
    callIndex: 0,
    countdownTimer: null,
    callTimer: null
  };
}

let state = freshState();

function pot() {
  return Object.keys(state.takenCards).length * STAKE;
}

function broadcastCardsUpdated() {
  io.emit('cards_updated', {
    takenCards: state.takenCards,
    playerCount: Object.keys(state.takenCards).length
  });
}

function startWaitingPhase() {
  state.phase = 'waiting';
  state.countdown = SELECTION_TIME;
  io.emit('phase_change', { phase: state.phase, countdown: state.countdown });

  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    state.countdown--;
    io.emit('countdown_tick', { countdown: state.countdown });
    if (state.countdown <= 0) {
      clearInterval(state.countdownTimer);
      if (Object.keys(state.takenCards).length > 0) {
        startGame();
      } else {
        startWaitingPhase(); // nobody joined, restart the 30s window
      }
    }
  }, 1000);
}

function startGame() {
  state.phase = 'playing';
  const playerCount = Object.keys(state.takenCards).length;
  const derash = Math.floor(pot() * 0.8);
  io.emit('game_start', { playerCount, pot: pot(), derash });

  clearInterval(state.callTimer);
  state.callTimer = setInterval(() => {
    if (state.remainingPool.length === 0) {
      clearInterval(state.callTimer);
      io.emit('no_winner');
      setTimeout(resetGame, 5000);
      return;
    }
    const number = state.remainingPool.pop();
    const letterIdx = Math.floor((number - 1) / 15);
    const letter = LETTERS[letterIdx];
    state.calledNumbers.push(number);
    state.callIndex++;
    io.emit('number_called', {
      number,
      letter,
      callIndex: state.callIndex,
      calledNumbers: state.calledNumbers
    });
  }, CALL_INTERVAL_MS);
}

function resetGame() {
  clearInterval(state.countdownTimer);
  clearInterval(state.callTimer);
  state = freshState();
  io.emit('game_reset', { phase: state.phase, calledNumbers: [] });
  startWaitingPhase();
}

// ---------- Bingo pattern validation ----------
function cardMarks(cardIndex) {
  const grid = cardToGrid(allCards[cardIndex]);
  const called = new Set(state.calledNumbers);
  return grid.map(row => row.map(v => v === 'FREE' || called.has(v)));
}

function hasWinningPattern(marks) {
  for (let r = 0; r < 5; r++) {
    if (marks[r].every(Boolean)) return 'row';
  }
  for (let c = 0; c < 5; c++) {
    if (marks.every(row => row[c])) return 'column';
  }
  if ([0, 1, 2, 3, 4].every(i => marks[i][i])) return 'diagonal';
  if ([0, 1, 2, 3, 4].every(i => marks[i][4 - i])) return 'diagonal';
  if (marks[0][0] && marks[0][4] && marks[4][0] && marks[4][4]) return 'corners';
  return null;
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  socket.on('player_join', (data) => {
    const player = getOrCreatePlayer(data || {});
    socketToTelegramId.set(socket.id, data.telegram_id);

    socket.emit('joined', {
      socketId: socket.id,
      allCards,
      player,
      gameState: {
        phase: state.phase,
        countdown: state.countdown,
        takenCards: state.takenCards,
        calledNumbers: state.calledNumbers
      }
    });

    io.emit('player_count', { count: io.engine.clientsCount });
    broadcastCardsUpdated();
  });

  socket.on('get_wallet', (data, callback) => {
    const tgId = socketToTelegramId.get(socket.id);
    const player = players.get(tgId);
    if (typeof callback === 'function') {
      callback({ wallet: player ? player.wallet : 0 });
    }
  });

  socket.on('select_card', ({ cardIndex }) => {
    const tgId = socketToTelegramId.get(socket.id);
    const player = players.get(tgId);
    if (!player || state.phase !== 'waiting') return;
    if (cardIndex === undefined || cardIndex < 0 || cardIndex >= allCards.length) return;

    if (state.takenCards[cardIndex] !== undefined && state.takenCards[cardIndex] !== tgId) {
      return; // already taken by someone else
    }

    if (!state.paidThisRound.has(tgId)) {
      if (player.wallet < STAKE) {
        socket.emit('insufficient_funds', { wallet: player.wallet, required: STAKE });
        return;
      }
      player.wallet -= STAKE;
      state.paidThisRound.add(tgId);
    }

    // free any previous card this player held
    for (const idx of Object.keys(state.takenCards)) {
      if (state.takenCards[idx] === tgId) delete state.takenCards[idx];
    }
    state.takenCards[cardIndex] = tgId;

    // Send the full card matrix back immediately so the client can render
    // the preview off this event alone, with no dependency on allCards timing.
    socket.emit('card_selected', {
      cardIndex,
      myWallet: player.wallet,
      card: allCards[cardIndex]
    });
    broadcastCardsUpdated();
  });

  socket.on('mark_cell', () => {
    // Client-side marking only; server validates independently on claim_bingo.
  });

  socket.on('claim_bingo', ({ cardIndex } = {}) => {
    const tgId = socketToTelegramId.get(socket.id);
    const player = players.get(tgId);
    const idx = cardIndex !== undefined ? cardIndex : Object.keys(state.takenCards)
      .find(k => state.takenCards[k] === tgId);

    if (!player || idx === undefined || state.takenCards[idx] !== tgId || state.phase !== 'playing') {
      socket.emit('false_bingo', { message: 'No active card for this player' });
      return;
    }

    const marks = cardMarks(idx);
    const pattern = hasWinningPattern(marks);
    if (!pattern) {
      socket.emit('false_bingo', { message: 'Not a valid Bingo yet' });
      return;
    }

    const prize = Math.floor(pot() * 0.8);
    player.wallet += prize;

    clearInterval(state.callTimer);
    io.emit('bingo_winner', {
      winner: {
        name: player.name,
        imageUrl: player.imageUrl,
        socketId: socket.id,
        cardIndex: Number(idx),
        card: allCards[idx],
        winPattern: pattern,
        prize
      },
      calledNumbers: state.calledNumbers
    });

    setTimeout(resetGame, 6000);
  });

  socket.on('disconnect', () => {
    socketToTelegramId.delete(socket.id);
    io.emit('player_count', { count: io.engine.clientsCount });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  startWaitingPhase();
});
