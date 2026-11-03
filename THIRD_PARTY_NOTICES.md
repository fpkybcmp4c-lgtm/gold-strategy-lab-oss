# 第三方软件与授权

根目录 `LICENSE` 的 MIT 授权适用于本项目原创代码和文档，不改变任何第三方软件的版权与授权。本仓库以源码和依赖锁文件交付，不提交 `node_modules`、框架构建包或第三方原生二进制。

## 授权核查范围

已对本次 Windows 依赖安装中解析到的包读取 `package.json` 的 `license` 字段，并检查下列特殊许可及其随包许可证。完整本机清单见 [docs/dependency-licenses.json](docs/dependency-licenses.json)。此清单记录实际安装结果，不代表其他操作系统上所有可选二进制包已经安装或逐一验证；每次依赖或平台变化均需重新核查。

| 软件 | 用途 | 上游声明的许可证 |
| --- | --- | --- |
| [Next.js](https://github.com/vercel/next.js) | 应用框架 | MIT |
| [React / React DOM](https://github.com/facebook/react) | 用户界面 | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | 图标 | ISC |
| [Recharts](https://github.com/recharts/recharts) | 统计图表 | MIT |
| [Zod](https://github.com/colinhacks/zod) | 输入校验 | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | 开发与类型检查 | Apache-2.0 |
| [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | 开发类型声明 | MIT |

## 需分别保留的授权

- `sharp` 本身声明 Apache-2.0；Windows 可选包 `@img/sharp-win32-x64` 声明 **Apache-2.0 AND LGPL-3.0-or-later**，其中 libvips 及其依赖另有授权。其他平台可能安装对应的 `@img/sharp-*` / `@img/sharp-libvips-*` 包。安装与分发这些二进制时应保留随包许可证、来源与适用的替换/再链接等权利，不能仅以本项目 MIT 许可证覆盖它们。参考 [sharp 安装与预编译二进制说明](https://sharp.pixelplumbing.com/install/)。
- `caniuse-lite` 数据声明 **CC-BY-4.0**，需保留相应署名和许可说明。上游为 [Browserslist / caniuse-lite](https://github.com/browserslist/caniuse-lite)，完整条款见其 [LICENSE](https://github.com/browserslist/caniuse-lite/blob/main/LICENSE)。
- `victory-vendor` 声明 **MIT AND ISC AND BSD-3-Clause**，包括所带 D3 组件的各自声明，见 [上游目录](https://github.com/FormidableLabs/victory/tree/main/packages/victory-vendor) 和安装包 `LICENSE.txt`。不能将该组合写成单一 MIT。
- 其余安装依赖还包含 MIT、ISC、Apache-2.0、BSD-3-Clause 和 0BSD 等声明，详见清单及各包的 LICENSE / NOTICE。

依赖通过包管理器按锁文件从软件包仓库安装，安装目录内的版权、LICENSE 和 NOTICE 文件应保留。若另行分发 Docker 镜像、离线依赖、可执行文件或打包后的前端，应根据所包含的实际文件一并提供相应通知、许可证和适用源码义务；本仓库的源码审查不替代那种二进制分发审查。

## 项目许可选择

项目采用 [MIT](https://opensource.org/license/mit) 作为原创代码的简洁宽松授权，保留软件按现状提供的条款。此次清理移除了未使用的托管平台构建插件、示例组件和平台 CSS，而没有将其中的第三方许可证改写为本项目署名。依赖元数据核查用于识别和保留第三方授权，并非对未知代码权属的保证；贡献者提交代码、图片或模板时应确认其有权按相应许可提供。
