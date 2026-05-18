/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      '@temporalio/client',
      '@temporalio/worker',
      '@temporalio/workflow',
      '@temporalio/activity',
      '@prisma/client',
    ],
  },
};

module.exports = nextConfig;
