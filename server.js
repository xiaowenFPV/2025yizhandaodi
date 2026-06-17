const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 房间存储
const rooms = {};

function generateRoomCode() {
  const chars = '0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createRoom() {
  let code;
  do { code = generateRoomCode(); } while (rooms[code]);
  rooms[code] = {
    code: code,
    players: [],       // [{id, socketId, name, score, ready, answers:[], connected}]
    questionCount: 0,
    questions: [],     // 共享题目列表
    state: 'waiting',  // waiting / selecting / playing / finished
    currentRound: 0,
  };
  return code;
}

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // === 创建房间 ===
  socket.on('createRoom', (playerName, callback) => {
    const code = createRoom();
    socket.join(code);
    rooms[code].players.push({
      id: 1,
      socketId: socket.id,
      name: playerName || '房主',
      score: 0,
      ready: true,
      answers: [],
      connected: true
    });
    socket.data.roomCode = code;
    socket.data.playerId = 1;
    console.log(`[房间] ${code} 已创建，房主: ${playerName}`);
    callback({ success: true, roomCode: code });
  });

  // === 加入房间 ===
  socket.on('joinRoom', (roomCode, playerName, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback({ success: false, error: '房间不存在' });
    if (room.players.length >= 2) return callback({ success: false, error: '房间已满' });
    if (room.state !== 'waiting') return callback({ success: false, error: '游戏已开始' });

    socket.join(roomCode);
    room.players.push({
      id: 2,
      socketId: socket.id,
      name: playerName || '挑战者',
      score: 0,
      ready: true,
      answers: [],
      connected: true
    });
    socket.data.roomCode = roomCode;
    socket.data.playerId = 2;
    console.log(`[房间] ${roomCode} 加入: ${playerName}`);

    // 通知双方对手已加入
    io.to(roomCode).emit('opponentJoined', {
      opponentName: room.players[0].name,
      yourName: room.players[1].name,
    });
    callback({ success: true });
  });

  // === 房主选择题目数量 ===
  socket.on('selectQuestionCount', (count) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.players[0].socketId !== socket.id) return;

    room.questionCount = count;
    room.state = 'playing';

    // 生成题目列表（基于题库，服务端也要有题库）
    // 这里客户端会自己生成并同步，服务端只记录数量
    io.to(code).emit('gameStart', {
      questionCount: count,
    });
    console.log(`[房间] ${code} 开始对战，共 ${count} 题`);
  });

  // === 同步题目种子 ===
  socket.on('syncQuestions', (questionsData) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    // 房主的题目数据作为权威，广播给另一方
    room.questions = questionsData;
    // 通知另一方用同样的题目
    socket.to(code).emit('receiveQuestions', questionsData);
  });

  // === 提交答案 ===
  socket.on('submitAnswer', (data) => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    player.answers[data.roundIndex] = {
      answer: data.answer,
      isCorrect: data.isCorrect,
    };

    // 检查双方是否都提交了本题
    const p1Answered = room.players[0].answers[data.roundIndex] !== undefined;
    const p2Answered = room.players[1] && room.players[1].answers[data.roundIndex] !== undefined;

    if (p1Answered && p2Answered) {
      const r1 = room.players[0].answers[data.roundIndex];
      const r2 = room.players[1].answers[data.roundIndex];

      // 更新分数
      if (r1.isCorrect) room.players[0].score++;
      if (r2.isCorrect) room.players[1].score++;

      // 广播本轮结果
      io.to(code).emit('roundResult', {
        roundIndex: data.roundIndex,
        correctAnswer: data.correctAnswer,
        player1: {
          name: room.players[0].name,
          answer: r1.answer,
          isCorrect: r1.isCorrect,
          score: room.players[0].score,
        },
        player2: {
          name: room.players[1].name,
          answer: r2.answer,
          isCorrect: r2.isCorrect,
          score: room.players[1].score,
        },
      });

      console.log(`[房间] ${code} 第${data.roundIndex+1}题: P1=${r1.isCorrect?'✓':'✗'} P2=${r2.isCorrect?'✓':'✗'}`);
    } else {
      // 告知双方当前已提交状态
      io.to(code).emit('answerStatus', {
        player1Ready: p1Answered,
        player2Ready: p2Answered,
        roundIndex: data.roundIndex,
      });
    }
  });

  // === 游戏结束 ===
  socket.on('gameOver', (data) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    room.state = 'finished';

    const p1 = room.players[0];
    const p2 = room.players[1];

    let winner = 'draw';
    if (p1.score > p2.score) winner = 'player1';
    else if (p2.score > p1.score) winner = 'player2';

    io.to(code).emit('gameOver', {
      player1: { name: p1.name, score: p1.score },
      player2: { name: p2.name, score: p2.score },
      winner: winner,
    });
    console.log(`[房间] ${code} 结束: ${p1.name}(${p1.score}) vs ${p2.name}(${p2.score})`);
  });

  // === 断线处理 ===
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    console.log(`[断开] ${socket.id} (房间: ${code}, 玩家: ${playerId})`);

    if (code && rooms[code]) {
      const room = rooms[code];
      const player = room.players.find(p => p.id === playerId);
      if (player) {
        player.connected = false;
      }
      // 通知对方对手断线
      socket.to(code).emit('opponentDisconnected', {
        playerName: player ? player.name : '对手',
      });
    }
  });

  // === 重新连接 ===
  socket.on('reconnect', (roomCode, playerId, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback({ success: false, error: '房间不存在' });

    const player = room.players.find(p => p.id === playerId);
    if (!player) return callback({ success: false, error: '玩家不存在' });

    player.connected = true;
    player.socketId = socket.id;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;

    callback({ success: true, state: room.state, score: player.score });
    socket.to(roomCode).emit('opponentReconnected');
    console.log(`[重连] ${socket.id} 回到房间 ${roomCode}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务运行在 http://localhost:${PORT}`);
});
