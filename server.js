const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
let nextPlayerId = 0;

// 决斗题库由客户端传入 ALL_QUESTIONS，不再硬编码

function generateRoomCode() {
  const chars = '0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostId, hostName) {
  let code;
  do { code = generateRoomCode(); } while (rooms[code]);
  const pid = ++nextPlayerId;
  rooms[code] = {
    code,
    hostSocketId: hostId,
    players: [{ id: pid, socketId: hostId, name: hostName, score: 0, answers: [], connected: true, ready: false }],
    state: 'waiting',
    questionCount: 0,
    questions: [],
    currentRound: 0,
    totalPlayers: 1,
  };
  return { code, pid };
}

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // === 创建房间 ===
  socket.on('createRoom', (playerName, callback) => {
    // 兼容客户端发送对象格式（如 duel 模式传来的 { name, gameMode }）
    if (!callback && typeof playerName === 'object') {
      const arr = Array.isArray(playerName) ? playerName : [playerName];
      playerName = arr[0];
      callback = arr[arr.length - 1];
    }
    // 兼容 playerName 是对象但 callback 已传入的情况（duel 模式）
    if (typeof playerName === 'object' && playerName !== null && playerName.name) {
      playerName = playerName.name;
    }
    if (typeof callback !== 'function') { console.error('[创建] callback 无效'); return; }
    const { code, pid } = createRoom(socket.id, playerName);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = pid;
    console.log(`[房间] ${code} 创建，房主: ${playerName} (${pid})`);

    // 广播玩家列表给房中所有人（格式匹配客户端 data.players 预期）
    const room = rooms[code];
    const playerListData = { players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, isHost: p.socketId === room.hostSocketId, ready: p.ready
    })) };
    io.to(code).emit('playerList', playerListData);

    callback({ success: true, roomCode: code, playerId: pid, players: room.players });
  });

  // === 加入房间 ===
  socket.on('joinRoom', (roomCode, playerName, callback) => {
    // 兼容 Socket.IO 多参数打包
    if (!callback && !playerName && typeof roomCode === 'object') {
      const arr = Array.isArray(roomCode) ? roomCode : [roomCode];
      roomCode = String(arr[0] || '');
      playerName = arr[1];
      callback = arr[2];
    }
    if (typeof callback !== 'function') { console.error('[加入] callback 无效'); return; }
    if (!roomCode || typeof roomCode !== 'string') {
      return callback({ success: false, error: '房间号格式错误' });
    }
    const room = rooms[roomCode];
    if (!room) return callback({ success: false, error: '房间不存在' });
    if (room.state !== 'waiting') return callback({ success: false, error: '游戏已开始' });

    const pid = ++nextPlayerId;
    socket.join(roomCode);
    room.players.push({
      id: pid, socketId: socket.id, name: playerName,
      score: 0, answers: [], connected: true, ready: false
    });
    socket.data.roomCode = roomCode;
    socket.data.playerId = pid;

    console.log(`[房间] ${roomCode} 加入: ${playerName} (${pid})，共 ${room.players.length} 人`);

    // 广播更新后的玩家列表（格式匹配客户端 data.players 预期）
    io.to(roomCode).emit('playerList', { players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, isHost: p.socketId === room.hostSocketId, ready: p.ready
    })) });

    callback({ success: true, playerId: pid, players: room.players });
  });
  // ============ 1v1 决斗事件 ============

  socket.on('duelReady', (data) => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.ready = true;
    // 存储客户端传入的题库
    if (data && data.questions && data.questions.length > 0 && !room.duelQuestionData) {
      room.duelQuestionData = data.questions;
    }
    console.log(`[决斗] ${code} ${player.name} 已准备`);
    socket.to(code).emit('duelReadyStatus', { playerId, ready: true });

    const allReady = room.players.length >= 2 && room.players.every(p => p.ready);
    if (allReady && room.state === 'waiting') {
      room.state = 'duel_countdown';
      io.to(code).emit('duelCountdown');
      console.log(`[决斗] ${code} 双方就绪，5秒后开始`);
      setTimeout(() => {
        if (!rooms[code] || room.state !== 'duel_countdown') return;
        startDuelGame(room, code);
      }, 5000);
    }
  });

  socket.on('duelUnready', () => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.ready = false;
    socket.to(code).emit('duelReadyStatus', { playerId, ready: false });
  });

  socket.on('duelAnswer', (data) => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = rooms[code];
    if (!room || room.state !== 'duel_playing') return;

    if (room.duelRoundTimeout) {
      clearTimeout(room.duelRoundTimeout);
      room.duelRoundTimeout = null;
    }

    if (!room.duelFirstAnswerer) {
      // 首位作答
      room.duelFirstAnswerer = playerId;
      room.duelFirstAnswer = data.answer;
      room.duelFirstCorrect = data.isCorrect;
      room.duelFirstAnswerTime = Date.now();

      if (data.isCorrect) {
        resolveDuelRound(room, code, playerId);
      } else {
        io.to(code).emit('duelFirstWrong', {
          playerId, answer: data.answer, correctAnswer: data.correctAnswer
        });
        room.duelRoundTimeout = setTimeout(() => {
          resolveDuelRound(room, code, null);
        }, 15000);
      }
    } else if (playerId !== room.duelFirstAnswerer) {
      // 第二位作答
      if (data.isCorrect) {
        resolveDuelRound(room, code, playerId);
      } else {
        resolveDuelRound(room, code, null); // 两人都错 → 作废
      }
    }
  });

  // ============ 决斗辅助函数（作用域内） ============

  function startDuelGame(room, code) {
    // 从客户端传入的题库中随机抽取 15 题
    const questionPool = room.duelQuestionData || [];
    const shuffled = [...questionPool].sort(() => Math.random() - 0.5);
    const questions = shuffled.slice(0, 15);
    room.state = 'duel_playing';
    room.duelQuestions = questions;
    room.duelCurrentRound = 0;
    room.duelWins = {};
    room.players.forEach(p => { room.duelWins[p.id] = 0; });
    room.duelRoundHistory = [];
    room.duelFirstAnswerer = null;
    room.duelFirstAnswer = null;
    room.duelFirstCorrect = null;

    io.to(code).emit('duelStart');
    console.log(`[决斗] ${code} 开始，${questions.length} 题`);
    sendDuelRound(room, code);
  }

  function sendDuelRound(room, code) {
    const q = room.duelQuestions[room.duelCurrentRound];
    if (!q) return;
    room.duelFirstAnswerer = null;
    room.duelFirstAnswer = null;
    room.duelFirstCorrect = null;
    room.duelFirstAnswerTime = null;

    const wins = room.players.map(p => ({ id: p.id, wins: room.duelWins[p.id] }));
    io.to(code).emit('duelRound', {
      question: q,
      roundIndex: room.duelCurrentRound,
      wins
    });

    // 15秒超时
    if (room.duelRoundTimeout) clearTimeout(room.duelRoundTimeout);
    room.duelRoundTimeout = setTimeout(() => {
      io.to(code).emit('duelTimeout');
      // 超时后再给 3 秒缓冲
      setTimeout(() => {
        if (room.state !== 'duel_playing') return;
        if (!room.duelFirstAnswerer) {
          resolveDuelRound(room, code, null);
        }
      }, 3000);
    }, 15000);
  }

  function resolveDuelRound(room, code, winnerId) {
    if (room.duelRoundTimeout) {
      clearTimeout(room.duelRoundTimeout);
      room.duelRoundTimeout = null;
    }

    const q = room.duelQuestions[room.duelCurrentRound];
    const isVoid = winnerId === null;
    const firstAnswererId = room.duelFirstAnswerer;
    const firstAnswer = room.duelFirstAnswer;
    const firstCorrect = room.duelFirstCorrect;

    if (!isVoid && winnerId) {
      room.duelWins[winnerId] = (room.duelWins[winnerId] || 0) + 1;
    }

    // 记录对局历史
    room.duelRoundHistory.push({
      roundIndex: room.duelCurrentRound,
      winnerId: isVoid ? null : winnerId,
      questionText: q ? q.q : ''
    });

    const wins = room.players.map(p => ({ id: p.id, wins: room.duelWins[p.id] }));
    const maxWins = Math.max(...Object.values(room.duelWins));
    const totalRounds = room.duelQuestions.length;
    const gameOver = maxWins >= 8 || room.duelCurrentRound >= totalRounds - 1;

    io.to(code).emit('duelRoundResult', {
      roundIndex: room.duelCurrentRound,
      correctAnswer: q ? q.a : '',
      winnerId: isVoid ? null : winnerId,
      firstAnswererId: isVoid ? firstAnswererId : null,
      firstAnswer: isVoid ? firstAnswer : null,
      firstCorrect: isVoid ? firstCorrect : null,
      wins,
      gameOver,
      void: isVoid
    });

    if (gameOver) {
      const sorted = [...room.players].sort((a, b) => (room.duelWins[b.id] || 0) - (room.duelWins[a.id] || 0));
      setTimeout(() => {
        room.state = 'finished';
        io.to(code).emit('duelOver', {
          ranking: sorted.map((p, i) => ({
            id: p.id, name: p.name, wins: room.duelWins[p.id], rank: i + 1
          })),
          roundHistory: room.duelRoundHistory
        });
      }, 3000);
    } else {
      room.duelCurrentRound++;
      setTimeout(() => {
        if (room.state !== 'duel_playing') return;
        sendDuelRound(room, code);
      }, 3500);
    }
  }

  // === 断线（10秒优雅期） ===
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    const player = room.players.find(p => p.id === playerId);
    if (player) player.connected = false;

    const leftPlayers = room.players.filter(p => p.connected);
    console.log(`[断开] ${player ? player.name : '?'} (${socket.id})，${leftPlayers.length}/${room.players.length} 在线，等待10秒优雅期`);

    // 10秒后仍未重连则通知其他玩家
    room._disconnectTimer = setTimeout(() => {
      if (!rooms[code]) return;
      const stillConnected = room.players.filter(p => p.connected);
      if (stillConnected.length > 0) {
        socket.to(code).emit('playerDisconnected', {
          playerId, playerName: player ? player.name : '未知',
          playerList: stillConnected.map(p => ({
            id: p.id, name: p.name, score: p.score,
            isHost: p.socketId === room.hostSocketId,
            ready: p.ready
          }))
        });
        console.log(`[通知] 玩家 ${player ? player.name : '?'} 断线，对方已收到通知`);
      }
      // 全部断开则清理房间
      if (stillConnected.length === 0) {
        // 清理决斗定时器
        if (room.duelRoundTimeout) {
          clearTimeout(room.duelRoundTimeout);
          room.duelRoundTimeout = null;
        }
        delete rooms[code];
        console.log(`[清理] 房间 ${code} 已移除（全员离线）`);
      }
      room._disconnectTimer = null;
    }, 10000);
  });

  // === 重连 ===
  socket.on('rejoinDuel', (data, ack) => {
    const { code, playerId, name } = data;
    if (!code || !rooms[code]) {
      if (ack) ack({ success: false, error: '房间不存在' });
      return;
    }

    const room = rooms[code];
    const player = room.players.find(p => p.id === playerId);
    if (!player) {
      if (ack) ack({ success: false, error: '玩家不存在' });
      return;
    }

    // 取消断线计时器
    if (room._disconnectTimer) {
      clearTimeout(room._disconnectTimer);
      room._disconnectTimer = null;
      console.log(`[重连] ${name} 已恢复，取消断线通知`);
    }

    // 恢复玩家状态
    player.connected = true;
    player.socketId = socket.id;
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    socket.join(code);

    const playerList = room.players.map(p => ({
      id: p.id, name: p.name, score: p.score,
      isHost: p.socketId === room.hostSocketId,
      ready: p.ready,
      connected: p.connected
    }));

    io.to(code).emit('playerReconnected', {
      playerId, playerName: name,
      playerList
    });

    if (ack) ack({ success: true, playerList, gameState: room.state });
    console.log(`[重连] ${name} 已恢复 (${room.state})`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务运行在 http://localhost:${PORT}`);
});
