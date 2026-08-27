const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// SQLite 데이터베이스 연결 (파일 기반)
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('DB 연결 실패:', err.message);
    else console.log('SQLite 데이터베이스 연결 성공');
});

// 테이블 생성 (사용자 정보: 이름, 비밀번호, 포인트, 역할)
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    points INTEGER DEFAULT 1000,
    role TEXT DEFAULT 'user'
)`);

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
        db.all("SELECT * FROM users WHERE role = 'user'", [], (err, rows) => {
            res.render('index', { user: { name: 'Admin', role: 'admin' }, users: rows });
        });
        return;
    }

    // 일반 사용자 조회
    db.get("SELECT * FROM users WHERE name = ?", [name], (err, row) => {
        if (row) {
            // 계정이 존재하는 경우 비밀번호 확인
            if (row.password === password) {
                res.render('index', { user: row });
            } else {
                res.send("<script>alert('비밀번호가 일치하지 않습니다.'); history.back();</script>");
            }
        } else {
            // 계정이 없는 경우 프론트엔드에서 회원가입 여부 확인 처리
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
});

// 신규 계정 자동 생성 라우트
app.get('/register-form', (req, res) => {
    const { name, password } = req.query;
    db.run("INSERT INTO users (name, password, points, role) VALUES (?, ?, 1000, 'user')", [name, password], function(err) {
        if (err) {
            res.send("<script>alert('계정 생성 중 오류가 발생했습니다.'); window.location.href='/';</script>");
        } else {
            db.get("SELECT * FROM users WHERE id = ?", [this.lastID], (err, row) => {
                res.render('index', { user: row });
            });
        }
    });
});

// 관리자: 포인트 실시간 수정 및 반영 API
app.post('/admin/update-points', (req, res) => {
    const { userId, points } = req.body;
    db.run("UPDATE users SET points = ? WHERE id = ?", [points, userId], function(err) {
        if (!err) {
            // Socket.io를 통해 접속 중인 모든 클라이언트에게 실시간 데이터 전송
            io.emit('pointsUpdated', { userId, points });
        }
        res.redirect('/');
    });
});

// Socket.io 실시간 연결 설정
io.on('connection', (socket) => {
    console.log('사용자가 실시간 연결되었습니다.');
});

// 서버 실행 (포트 3000)
server.listen(3000, () => {
    console.log('서버가 실행 중입니다: http://localhost:3000');
});