cd server
node -e "import('bcrypt').then(b => b.default.hash('ваш-пароль', 10).then(h => console.log(h)))"