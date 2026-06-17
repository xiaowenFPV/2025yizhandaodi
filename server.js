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
    players: [{ id: pid, socketId: hostId, name: hostName, score: 0, answers: [], connected: true }],
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
      id: p.id, name: p.name, score: p.score, isHost: p.socketId === room.hostSocketId
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
      score: 0, answers: [], connected: true
    });
    socket.data.roomCode = roomCode;
    socket.data.playerId = pid;

    console.log(`[房间] ${roomCode} 加入: ${playerName} (${pid})，共 ${room.players.length} 人`);

    // 广播更新后的玩家列表（格式匹配客户端 data.players 预期）
    io.to(roomCode).emit('playerList', { players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, isHost: p.socketId === room.hostSocketId
    })) });

    callback({ success: true, playerId: pid, players: room.players });
  });

  // === 房主选择题目数量并开始 ===
  socket.on('startGame', (questionCount, questionsData) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;
    if (room.state !== 'waiting') return;

    // 兼容 Socket.IO 多参数：如果 questionsData 为空但 questionCount 是数组，则交换
    if (!questionsData && Array.isArray(questionCount)) {
      const arr = questionCount;
      questionCount = arr[0];
      questionsData = arr[1];
    }

    const qc = parseInt(questionCount) || 0;
    if (qc <= 0) return;
    if (!Array.isArray(questionsData) || questionsData.length === 0) return;

    room.questionCount = qc;
    room.questions = questionsData;
    room.state = 'playing';
    room.currentRound = 0;

    io.to(code).emit('gameStart', {
      questionCount: qc,
      questions: questionsData,
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
    });
    console.log(`[房间] ${code} 游戏开始，${room.players.length} 人，${qc} 题`);
  });

  // === 提交答案 ===
  socket.on('submitAnswer', (data) => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = rooms[code];
    if (!room) return;
    if (room.state !== 'playing') return;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    if (player.answers[data.roundIndex] !== undefined) return; // 防止重复提交

    player.answers[data.roundIndex] = {
      answer: data.answer,
      isCorrect: data.isCorrect,
    };

    // 检查是否所有人已提交
    const allAnswered = room.players.every(p => p.answers[data.roundIndex] !== undefined);
    const answeredCount = room.players.filter(p => p.answers[data.roundIndex] !== undefined).length;

    if (allAnswered) {
      // 更新分数
      room.players.forEach(p => {
        if (p.answers[data.roundIndex].isCorrect) p.score++;
      });

      // 本轮排名（按累计得分降序）
      const sorted = [...room.players].sort((a, b) => b.score - a.score);

      const results = room.players.map(p => ({
        id: p.id,
        name: p.name,
        answer: p.answers[data.roundIndex].answer,
        isCorrect: p.answers[data.roundIndex].isCorrect,
        score: p.score,
      }));

      io.to(code).emit('roundResult', {
        roundIndex: data.roundIndex,
        correctAnswer: data.correctAnswer,
        results,
        ranking: sorted.map((p, i) => ({ id: p.id, name: p.name, score: p.score, rank: i + 1 })),
        isLastRound: data.roundIndex >= room.questionCount - 1,
      });

      console.log(`[房间] ${code} R${data.roundIndex+1}/${room.questionCount}: ${answeredCount}/${room.players.length} 人已答`);
    } else {
      io.to(code).emit('answerStatus', {
        roundIndex: data.roundIndex,
        answeredCount,
        totalPlayers: room.players.length,
      });
    }
  });

  // === 游戏结束 ===
  socket.on('gameOver', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    room.state = 'finished';

    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    io.to(code).emit('gameOver', {
      ranking: sorted.map((p, i) => ({ id: p.id, name: p.name, score: p.score, rank: i + 1 })),
    });
    console.log(`[房间] ${code} 结束，冠军: ${sorted[0].name}(${sorted[0].score})`);
  });

  // === 断线 ===
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    const player = room.players.find(p => p.id === playerId);
    if (player) player.connected = false;

    const leftPlayers = room.players.filter(p => p.connected);
    socket.to(code).emit('playerDisconnected', {
      playerId, playerName: player ? player.name : '未知',
      playerList: leftPlayers.map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.socketId === room.hostSocketId }))
    });

    // 如果全部断开，清理房间
    if (leftPlayers.length === 0) {
      delete rooms[code];
      console.log(`[清理] 房间 ${code} 已移除`);
    }

    console.log(`[断开] ${player ? player.name : '?'} (${socket.id})`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务运行在 http://localhost:${PORT}`);
});
