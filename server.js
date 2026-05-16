const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const ALL_LINES = [
  [0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,15],
  [0,4,8,12],[1,5,9,13],[2,6,10,14],[3,7,11,15],
  [0,5,10,15],[3,6,9,12]
];
const DIAGS = [[0,5,10,15],[3,6,9,12]];

const complete  = (cells, i) => cells[i].x && cells[i].o;
const myKey     = p => p === 1 ? 'x' : 'o';
const oppKey    = p => p === 1 ? 'o' : 'x';
const boardFull = cells => cells.every((_, j) => complete(cells, j));
const ccDone    = cc => cc.x && cc.o;

function winLine(cells) {
  for (const l of ALL_LINES) if (l.every(i => complete(cells, i))) return l;
  return null;
}

function checkBtn({ cells, centerCell, turn }) {
  const my = myKey(turn), opp = oppKey(turn);
  for (const d of DIAGS) {
    const done = d.filter(i => complete(cells, i)).length;
    if (done !== 3) continue;
    const fourth = d.find(i => !complete(cells, i));
    if (fourth === undefined) continue;
    if (cells[fourth][opp] && !cells[fourth][my]) return { target: fourth, addKey: my };
    if (ccDone(centerCell) && cells[fourth][my] && !cells[fourth][opp])
      return { target: fourth, addKey: opp };
  }
  return null;
}

function newState(scores = [0, 0]) {
  return {
    cells: Array(16).fill(0).map(() => ({ x: false, o: false })),
    centerCell: { x: false, o: false },
    turn: 1, over: false, winner: null, winningLine: null,
    btnReady: false, btnTarget: null, btnAddKey: null,
    centerLocked: false, scores: [...scores], status: 'playing'
  };
}

function doWin(state, line) {
  state.scores[state.turn - 1]++;
  state.over = true; state.winner = state.turn;
  state.winningLine = line; state.status = 'win';
  state.btnReady = false; state.btnTarget = null;
}

function doDraw(state) { state.over = true; state.status = 'draw'; }
function endTurn(state, center) { state.centerLocked = !!center; state.turn = state.turn === 1 ? 2 : 1; }

function applyPlace(state, idx) {
  if (state.over) return false;
  const { cells, turn, btnReady } = state;
  if (btnReady) {
    state.btnReady = false; state.btnTarget = null; state.btnAddKey = null;
    endTurn(state, false); return true;
  }
  if (complete(cells, idx) || cells[idx][myKey(turn)]) return false;
  cells[idx][myKey(turn)] = true;
  state.btnReady = false;
  if (complete(cells, idx)) {
    const wl = winLine(cells); if (wl) { doWin(state, wl); return true; }
    if (boardFull(cells)) { doDraw(state); return true; }
  }
  const wl = winLine(cells); if (wl) { doWin(state, wl); return true; }
  const t = checkBtn(state);
  if (t) { state.btnReady = true; state.btnTarget = t.target; state.btnAddKey = t.addKey; return true; }
  endTurn(state, false); return true;
}

function applyPressCenter(state) {
  if (state.over) return false;
  const { cells, centerCell, turn, btnReady, btnTarget, btnAddKey, centerLocked } = state;
  if (btnReady && btnTarget !== null) {
    const key = btnAddKey || myKey(turn);
    cells[btnTarget][key] = true;
    state.btnReady = false; state.btnTarget = null; state.btnAddKey = null;
    const wl = winLine(cells); if (wl) { doWin(state, wl); return true; }
    endTurn(state, false); return true;
  }
  if (centerCell[myKey(turn)] || centerLocked) return false;
  centerCell[myKey(turn)] = true;
  const wl = winLine(cells); if (wl) { doWin(state, wl); return true; }
  endTurn(state, true); return true;
}

io.on('connection', socket => {
  socket.on('create-room', cb => {
    const roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
    rooms.set(roomId, { players: { 1: socket.id, 2: null }, sToP: { [socket.id]: 1 }, state: newState() });
    socket.join(roomId);
    socket.data.roomId = roomId; socket.data.pNum = 1;
    cb({ roomId });
  });

  socket.on('join-room', ({ roomId }, cb) => {
    const rid = roomId.toUpperCase(), room = rooms.get(rid);
    if (!room) return cb({ error: 'Room not found' });
    if (room.players[2]) return cb({ error: 'Room is full' });
    room.players[2] = socket.id; room.sToP[socket.id] = 2;
    socket.join(rid);
    socket.data.roomId = rid; socket.data.pNum = 2;
    io.to(rid).emit('game-start', { state: room.state });
    cb({ ok: true });
  });

  socket.on('make-move', ({ cellIndex }) => {
    const { roomId, pNum } = socket.data; if (!roomId) return;
    const room = rooms.get(roomId); if (!room || room.state.over) return;
    if (pNum !== room.state.turn) return;
    if (applyPlace(room.state, cellIndex)) io.to(roomId).emit('state-update', { state: room.state });
  });

  socket.on('press-center', () => {
    const { roomId, pNum } = socket.data; if (!roomId) return;
    const room = rooms.get(roomId); if (!room || room.state.over) return;
    if (pNum !== room.state.turn) return;
    if (applyPressCenter(room.state)) io.to(roomId).emit('state-update', { state: room.state });
  });

  socket.on('play-again', () => {
    const { roomId } = socket.data; if (!roomId) return;
    const room = rooms.get(roomId); if (!room || !room.state.over) return;
    room.state = newState(room.state.scores);
    io.to(roomId).emit('state-update', { state: room.state });
  });

  socket.on('disconnect', () => {
    const { roomId } = socket.data; if (!roomId) return;
    const room = rooms.get(roomId); if (!room) return;
    io.to(roomId).emit('opponent-left');
    rooms.delete(roomId);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Match server running on port ${PORT}`));
