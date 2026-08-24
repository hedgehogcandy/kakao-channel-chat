// PM2 상시 구동 설정:  pm2 start ecosystem.config.cjs
// 앱이 .env 를 스스로 로드하므로 여기엔 시크릿을 두지 않는다.
module.exports = {
  apps: [
    {
      name: 'kakao-channel',
      script: 'bin/kbc.js',
      args: 'daemon',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 100,
      restart_delay: 5000,
      // 자동응답을 켜려면: args: 'daemon --autoreply'  또는 .env 에 KBC_AUTOREPLY=1
    },
  ],
};
