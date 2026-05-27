#!/bin/bash
cd "/Users/admin/gold"
echo "启动黄金价格监控"
nohup node server.js > /dev/null 2>&1 &
# 直接退出，终端窗口自动关闭
exit
