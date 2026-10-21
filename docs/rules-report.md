# 规则库审计报告

- 来源：catalog.json（PC-Cleaner 0.9.9（导入时间 2026-10-18T07:10:54.078Z）） + extra.json（手工补充（2026-10））
- 生成时间：2026-10-20T07:00:01.649Z
- 规模：37 个分类 / 401 条规则 / 414 个候选根目录
- 结构校验：0 个错误，0 个提示；未实现的规则类型 0 条（无，全部规则类型均已实现）
- 本机可命中的根目录：147 个；登记辖区后仍被路径策略拦截：18 个

## 分类明细

| 分类 | 风险 | 界面归类 | 规则数 | 候选根 | 本机存在 | 策略拦截 | 策略放行 | 未实现 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 开发工具缓存（dev_caches） | caution | dev | 33 | 33 | 13 | 2 | 11 | 0 |
| 浏览器/网页缓存（web_cache） | safe | browser | 28 | 28 | 14 | 0 | 14 | 0 |
| 系统日志与诊断残留（system_logs） | safe | system | 28 | 28 | 23 | 4 | 19 | 0 |
| 浏览器站点数据(高风险)（browser_data） | risky | privacy | 27 | 27 | 9 | 0 | 9 | 0 |
| 更多开发工具缓存（extra_dev） | safe | dev | 20 | 20 | 3 | 0 | 3 | 0 |
| 系统深度清理(需管理员)（system_admin） | caution | system | 17 | 17 | 14 | 7 | 7 | 0 |
| 微信运行缓存（wechat_cache） | safe | apps | 16 | 22 | 14 | 0 | 14 | 0 |
| 更多游戏平台缓存（extra_games） | safe | apps | 15 | 15 | 0 | 0 | 0 | 0 |
| 云盘与同步工具缓存（extra_cloud） | safe | apps | 15 | 15 | 0 | 0 | 0 | 0 |
| 通讯与会议缓存（extra_chat） | caution | apps | 15 | 15 | 0 | 0 | 0 | 0 |
| 影音播放缓存（extra_media） | safe | apps | 15 | 15 | 0 | 0 | 0 | 0 |
| 办公与创意软件缓存（extra_office） | safe | apps | 15 | 15 | 0 | 0 | 0 | 0 |
| 变态级隐蔽缓存(系统账户/下载中断/媒体应用)（extreme_stealth） | caution | system | 14 | 14 | 2 | 1 | 1 | 0 |
| 常用工具与显卡缓存（extra_tools） | safe | apps | 13 | 13 | 1 | 0 | 1 | 0 |
| 浏览器数据库压缩（database_compact） | safe | browser | 12 | 12 | 5 | 0 | 5 | 0 |
| 更多浏览器缓存（extra_browsers） | safe | browser | 12 | 12 | 1 | 0 | 1 | 0 |
| 游戏平台缓存（game_caches） | caution | apps | 10 | 15 | 2 | 0 | 2 | 0 |
| 更多系统缓存（extra_windows） | safe | system | 10 | 10 | 6 | 0 | 6 | 0 |
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

- C:\Windows/Logs/CBS（system_admin-16 与 system_logs-2）
- C:\Windows/Logs/WindowsUpdate（system_admin-8 与 system_logs-6）
- C:\Windows/System32/winevt/Logs（system_admin-10 与 extreme_stealth-2）
- C:\Users\Administrator.DESKTOP-B166QN2\AppData\Roaming/Tencent/WeChat/Logs（wechat_cache-15 与 extreme_stealth-11）
- C:\Users\Administrator.DESKTOP-B166QN2\.gradle\caches（dev_caches-18 与 extra-dev-1）

## 受保护目标样例（需清空白名单或不应清理）

- dev_caches-4 → C:/（protected：驱动器根目录）
- dev_caches-5 → D:/（protected：驱动器根目录）
- downloads-1 → C:\Users\Administrator.DESKTOP-B166QN2\Downloads（protected：C:\Users\Administrator.DESKTOP-B166QN2\Downloads）
- downloads-2 → C:\Users\Administrator.DESKTOP-B166QN2\Downloads（protected：C:\Users\Administrator.DESKTOP-B166QN2\Downloads）
- downloads-3 → C:\Users\Administrator.DESKTOP-B166QN2\Downloads（protected：C:\Users\Administrator.DESKTOP-B166QN2\Downloads）
- system_admin-5 → C:/（protected：驱动器根目录）
- system_admin-6 → C:\Windows（protected：C:\Windows\System32）
- system_admin-7 → C:\Windows（protected：C:\Windows\System32）
- system_admin-9 → C:\Windows/System32/winevt/Logs（protected：C:\Windows\System32）
- system_admin-10 → C:\Windows/System32/winevt/Logs（protected：C:\Windows\System32）
- system_admin-11 → C:\Windows（protected：C:\Windows\System32）
- system_admin-14 → C:\Windows/assembly（outside：不在清空白名单内）

