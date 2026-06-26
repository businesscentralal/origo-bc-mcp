/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    {
      name: "mcp-server",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
      // PM2 log management
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
