# 规则库审计报告

- 来源：PC-Cleaner 0.9.9（导入时间 2026-10-18T07:10:54.078Z）
- 生成时间：2026-10-18T07:18:09.373Z
- 规模：28 个分类 / 271 条规则 / 284 个候选根目录
- 结构校验：0 个错误，0 个提示；暂未实现的规则类型 0 条（broken_shortcuts / compact_db）
- 本机可命中的根目录：136 个；登记辖区后仍被路径策略拦截：17 个

## 分类明细

| 分类 | 风险 | 界面归类 | 规则数 | 候选根 | 本机存在 | 策略拦截 | 策略放行 | 未实现 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 开发工具缓存（dev_caches） | caution | dev | 33 | 33 | 13 | 2 | 11 | 0 |
| 浏览器/网页缓存（web_cache） | safe | browser | 28 | 28 | 14 | 0 | 14 | 0 |
| 系统日志与诊断残留（system_logs） | safe | system | 28 | 28 | 23 | 4 | 19 | 0 |
| 浏览器站点数据(高风险)（browser_data） | risky | privacy | 27 | 27 | 9 | 0 | 9 | 0 |
| 系统深度清理(需管理员)（system_admin） | caution | system | 17 | 17 | 14 | 6 | 8 | 0 |
| 微信运行缓存（wechat_cache） | safe | apps | 16 | 22 | 14 | 0 | 14 | 0 |
| 变态级隐蔽缓存(系统账户/下载中断/媒体应用)（extreme_stealth） | caution | system | 14 | 14 | 2 | 1 | 1 | 0 |
| 浏览器数据库压缩（database_compact） | safe | browser | 12 | 12 | 5 | 0 | 5 | 0 |
| 游戏平台缓存（game_caches） | caution | apps | 10 | 15 | 2 | 0 | 2 | 0 |
| 直播伴侣/电竞平台缓存（live_stream_cache） | caution | apps | 9 | 9 | 5 | 0 | 5 | 0 |
| 浏览器隐私数据(高风险)（browser_privacy） | risky | privacy | 9 | 9 | 3 | 0 | 3 | 0 |
| 系统临时文件（system_temp） | safe | system | 8 | 8 | 5 | 0 | 5 | 0 |
| WebView2 嵌入式浏览器缓存（webview2_caches） | caution | browser | 8 | 8 | 8 | 0 | 8 | 0 |
| GPU 着色器缓存（gpu_caches） | safe | system | 7 | 7 | 3 | 0 | 3 | 0 |
| 游戏运行时缓存（game_runtime_cache） | caution | apps | 6 | 6 | 1 | 0 | 1 | 0 |
| 云盘与商店应用缓存（cloud_app_hidden） | safe | apps | 5 | 5 | 2 | 0 | 2 | 0 |
| 崩溃上报与遥测数据（crash_telemetry） | safe | system | 5 | 5 | 1 | 0 | 1 | 0 |
| 通信工具缓存（comm_caches） | safe | apps | 4 | 4 | 0 | 0 | 0 | 0 |
| Java/远程桌面/字体缓存（java_rdp_legacy） | safe | system | 4 | 4 | 0 | 0 | 0 | 0 |
| NVIDIA 应用缓存（nvidia_app_cache） | safe | system | 3 | 3 | 3 | 0 | 3 | 0 |
| 办公软件缓存（office_caches） | safe | apps | 3 | 3 | 0 | 0 | 0 | 0 |
| 下载/旧文件（downloads） | risky | disk | 3 | 3 | 3 | 3 | 0 | 0 |
| 回收站与诊断日志(ETL)（recycle_and_diagnostics） | caution | system | 3 | 3 | 2 | 1 | 1 | 0 |
| 使用痕迹（usage_traces） | caution | privacy | 3 | 5 | 4 | 0 | 4 | 0 |
| 多媒体设计软件缓存（media_caches） | safe | apps | 2 | 2 | 0 | 0 | 0 | 0 |
| 隐蔽的安装包/升级残留（hidden_installer_backups） | caution | system | 2 | 2 | 0 | 0 | 0 | 0 |
| 旧版 Windows 残留（windows_old） | risky | system | 1 | 1 | 0 | 0 | 0 | 0 |
| 远程桌面旧版缓存(用户文档)（rdp_legacy_cache） | caution | system | 1 | 1 | 0 | 0 | 0 | 0 |

## 重复目标

- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/CrashDumps（system_temp-1 与 system_temp-2）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/Microsoft/Windows/Explorer（system_temp-1 与 system_temp-3）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/Microsoft/Windows/Explorer（system_temp-1 与 system_temp-4）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/Microsoft/Windows/WebCache（system_temp-1 与 system_temp-5）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/Microsoft/Windows/WER（system_temp-1 与 system_temp-6）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/Microsoft/Windows/Caches（system_temp-1 与 system_temp-7）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/Microsoft/FontCache/4/CloudFonts（system_temp-1 与 system_temp-8）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/NVIDIA/DXCache（system_temp-1 与 gpu_caches-1）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/NVIDIA/GLCache（system_temp-1 与 gpu_caches-2）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/AMD/DXCache（system_temp-1 与 gpu_caches-3）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/AMD/GLCache（system_temp-1 与 gpu_caches-4）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/D3DSCache（system_temp-1 与 gpu_caches-5）
- C:\ProgramData/NVIDIA Corporation/NV_Cache（system_temp-1 与 gpu_caches-6）
- C:\Users\Administrator.DESKTOP-B166QN2/AppData/LocalLow/NVIDIA/DXCache（system_temp-1 与 gpu_caches-7）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/NVIDIA Corporation/NVIDIA App/CefCache（system_temp-1 与 nvidia_app_cache-1）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/NVIDIA Corporation/NVIDIA Overlay/CefCache（system_temp-1 与 nvidia_app_cache-2）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/NVIDIA Corporation/NVIDIA App/NvBackend/ApplicationOntology（system_temp-1 与 nvidia_app_cache-3）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/Microsoft/Edge/User Data（system_temp-1 与 web_cache-1）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/Microsoft/Edge/User Data（system_temp-1 与 web_cache-2）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Local/Steam/htmlcache（system_temp-1 与 web_cache-3）

## 受保护目标样例（需清空白名单或不应清理）

- （）
- （）
- （）
- （）
- （）
- （）
- （）
- （）
- （）
- （）
- （）
- （）

