/**
 * Rspack configuration - usa SWC nativamente, evita bugs de esbuild
 * Similar a vite.config.js pero para Rspack
 */

const path = require('path');
const { ReactRefreshRspackPlugin } = require('@rspack/plugin-react-refresh');

const isDev = process.env.NODE_ENV === 'development';

/** @type {import('@rspack/cli').Configuration} */
module.exports = {
  context: __dirname,
  entry: {
    main: './frontend/src/main.jsx',
  },
  output: {
    path: path.resolve(__dirname, 'frontend/dist'),
    filename: 'assets/[name]-[contenthash:8].js',
    chunkFilename: 'assets/[name]-[contenthash:8].chunk.js',
    clean: true,
    publicPath: '/',
  },
  resolve: {
    extensions: ['.js', '.jsx', '.json'],
    alias: {
      '@': path.resolve(__dirname, 'frontend/src'),
    },
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: {
                syntax: 'ecmascript',
                jsx: true,
              },
              transform: {
                react: {
                  runtime: 'automatic',
                  development: isDev,
                  refresh: isDev,
                },
              },
            },
          },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
        type: 'javascript/auto',
      },
      {
        test: /\.(png|jpg|jpeg|gif|svg|woff|woff2|eot|ttf)$/,
        type: 'asset/resource',
      },
    ],
  },
plugins: [
    isDev ? new ReactRefreshRspackPlugin() : null,
    new (require('@rspack/core').DefinePlugin)({
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    }),
  ],
  devServer: {
    port: 5173,
    hot: true,
    client: {
      overlay: {
        errors: true,
        warnings: false,
      },
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
    historyApiFallback: true,
  },
  experiments: {
    css: true,
  },
  optimization: {
    minimize: !isDev,
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          chunks: 'all',
        },
      },
    },
  },
  // Performance hints
  performance: {
    hints: isDev ? false : 'warning',
  },
};