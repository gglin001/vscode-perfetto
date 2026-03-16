# vscode-perfetto

在 VS Code 中直接打开内置 Perfetto UI。扩展通过 `vscode.workspace.fs` 读取文件, 所以本地和 Remote-SSH 都可用。

右键 `.json`、`.chrom_trace` 或 `.chrome_trace` 文件, 选择 `Open in Perfetto` 即可打开。也可以先打开文件, 再运行命令 `Perfetto: Open in Perfetto`。

需要看调试日志时, 运行命令 `Perfetto: Show Output`。

更新内置 Perfetto UI:

```bash
pnpm run perfetto:fetch
pnpm run perfetto:build:source
```

## 开发

```bash
pnpm install
pnpm run compile
pnpm run package:vsix
```

按 `F5` 启动调试。需要切到外部 Perfetto UI 时, 把 `perfetto.uiUrl` 改成对应地址即可。
