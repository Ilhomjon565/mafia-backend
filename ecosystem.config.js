// pm2 ecosystem — mustahkam ishlash uchun.
// Ishga tushirish:  pm2 start ecosystem.config.js   (yoki: pm2 start ecosystem.config.js --only mafia-backend)
// Saqlash:          pm2 save   (reboot'dan keyin tiklash uchun: pm2 startup)
module.exports = {
  apps: [
    {
      name: 'mafia-backend',
      script: 'server.js',
      cwd: '/root/mafia-backend',
      exec_mode: 'fork',            // Socket.io + xotiradagi holat — bitta instansiya (cluster EMAS)
      instances: 1,
      autorestart: true,            // crash bo'lsa avtomatik qayta ishga tushadi
      max_memory_restart: '500M',   // xotira shishsa qayta ishga tushadi (zaif server himoyasi)
      exp_backoff_restart_delay: 200, // crash-loop'da bosqichma-bosqich kechikish
      max_restarts: 50,
      kill_timeout: 5000,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'mafia-watchdog',
      script: 'watchdog.js',
      cwd: '/root/mafia-backend',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '80M',
      env: {
        WATCH_URL: 'http://localhost:4100/health',
        WATCH_APP: 'mafia-backend',
        WATCH_INTERVAL: '15000',
        WATCH_MAX_FAILS: '3',
      },
    },
  ],
};
