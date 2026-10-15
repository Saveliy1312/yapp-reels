#!/usr/bin/env bash
# Дежурство: GitHub запускает cron с опозданием на часы (с 14.10.2026 - раз в 4-6 часов вместо получаса),
# поэтому один запуск сам проверяет очередь каждые 2 минуты почти 5 часов и сохраняет отметки сразу.
# Использование: scripts/watch.sh <скрипт.mjs> <файлы отметок> <текст коммита>
set -u
script=$1; files=$2; msg=$3
end=$(( $(date +%s) + ${WATCH_MIN:-290} * 60 ))
failed=0

git config user.name "yapp-reels-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

save() {
  git add $files
  git diff --cached --quiet && return 0
  git commit -qm "$msg: $(date -u +%F' '%H:%M) UTC"
  git pull -q --rebase && git push -q
}

while :; do
  git pull -q --rebase || true            # свежая очередь: новая партия подхватится без перезапуска
  node "scripts/$script" publish || failed=1
  save || failed=1
  [ "$(date +%s)" -ge "$end" ] && break
  sleep 120
done
exit $failed
