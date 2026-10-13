#!/bin/zsh
set -euo pipefail

printf "请粘贴 Zeabur 的 LUMI_TAKEOUT_BRIDGE_TOKEN（输入不会显示）： "
read -s token
printf "\n"
if [[ -z "$token" ]]; then
  echo "没有输入令牌。"
  exit 1
fi
security add-generic-password -U \
  -s com.cai5232.Lumi \
  -a takeout-bridge-token \
  -w "$token"
unset token
echo "已安全保存到本机钥匙串。"
