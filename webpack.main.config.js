module.exports = {
  entry: './src/main.ts',
  target: 'electron-main',
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: [{
          loader: 'ts-loader',
          // 只对实际打进包的��件做类型检查。
          // tsconfig 的 include 覆盖 tests/**，若不开启此项，
          // 测试文件的类型错误会导致 webpack 构建失败。
          options: { onlyCompileBundledFiles: true },
        }],
      },
      { test: /\.png$/i, type: 'asset/resource' },
    ],
  },
  resolve: { extensions: ['.ts', '.tsx', '.js', '.json'] },
  externals: { 'uiohook-napi': 'commonjs2 uiohook-napi' },
};
