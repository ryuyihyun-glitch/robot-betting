const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// SQLite 데이터베이스 연결 (better-sqlite3 방식)
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);
console.log('SQLite 데이터베이스 연결 성공');

// 테이블 생성 (사용자 정보: 이름, 비밀번호, 포인트, 역할)
db.prepare(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    points INTEGER DEFAULT 1000,
    role TEXT DEFAULT 'user'
)`).run();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

// 1. 로그인 / 메인 페이지
app.get('/', (req, res) => {
    res.render('index', { user: null });
});

// 로그인 및 회원가입 처리 로직
app.post('/login', (req, res) => {
    const { name, password } = req.body;

    // 관리자 계정 하드코딩 처리
    if (name === 'Admin' && password === 'whitedog0508') {
        const rows = db.prepare("SELECT * FROM users WHERE role = 'user'").all();
        res.render('index', { user: { name: 'Admin', role: 'admin' }, users: rows });
        return;
    }

    // 일반 사용자 조회
    const row = db.prepare("SELECT * FROM users WHERE name = ?").get(name);
    if (row) {
        if (row.password === password) {
            res.render('index', { user: row });
        } else {
            res.send("<script>alert('비밀번호가 일치하지 않습니다.'); history.back();</script>");
        }
    } else {
        res.send(`
            <script>
                if (confirm('동일한 이름의 계정이 없습니다. 새 계정을 생성하시겠습니까?')) {
                    window.location.href = '/register-form?name=${encodeURIComponent(name)}&password=${encodeURIComponent(password)}';
                } else {
                    history.back();
                }
            </script>
        `);
    }
});

// 신규 계정 자동 생성 라우트
app.get('/register-form', (req, res) => {
    const { name, password } = req.query;
    try {
        const stmt = db.prepare("INSERT INTO users (name, password, points, role) VALUES (?, ?, 1000, 'user')");
        const info = stmt.run(name, password);
        const row = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
        res.render('index', { user: row });
    } catch (err) {
        res.send("<script>alert('계정 생성 중 오류가 발생했습니다.'); window.location.href='/';</script>");
    }
});

// 관리자: 포인트 실시간 수정 및 반영 API
app.post('/admin/update-points', (req, res) => {
    const { userId, points } = req.body;
    try {
        db.prepare("UPDATE users SET points = ? WHERE id = ?").run(points, userId);
        io.emit('pointsUpdated', { userId, points });
    } catch (err) {
        console.error('포인트 업데이트 실패:', err);
    }
    res.redirect('/');
});

// Socket.io 실시간 연결 설정
io.on('connection', (socket) => {
    console.log('사용자가 실시간 연결되었습니다.');
});

// 서버 실행 (포트 3000)
server.listen(3000, () => {
    console.log('서버가 실행 중입니다: http://localhost:3000');
});