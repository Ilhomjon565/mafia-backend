#!/usr/bin/env bash
# ==============================================================================
#  coturn (TURN server) o'rnatish — mafia-game.uz ovozli chati uchun
# ==============================================================================
#  NIMA UCHUN: STUN faqat NAT ni "teshish" mumkin bo'lganda yordam beradi.
#  Simmetrik NAT va CGNAT ortida (mobil operatorlar) to'g'ridan-to'g'ri kanal
#  QURILMAYDI va ovoz umuman ulanmaydi. TURN bunday juftlikda ovozni server
#  orqali uzatadi.
#
#  ISHLATISH:  sudo bash /srv/mafia/backend/setup-turn.sh
#
#  Skript idempotent: qayta ishga tushirsa ham zarar qilmaydi, mavjud
#  konfiguratsiyani zaxiralaydi va sirni qayta yaratmaydi.
#
#  DIQQAT — BU SERVER NAT ORTIDA (ichki 192.168.88.10, tashqi 93.188.87.165).
#  Skript coturn'ni to'g'ri sozlaydi, LEKIN routerda port forward QO'LDA
#  qilinishi kerak. Skript oxirida kerakli ro'yxatni chiqaradi.
# ==============================================================================
set -euo pipefail

ENV_FILE=/srv/mafia/backend.env
CONF=/etc/turnserver.conf
DEFAULTS=/etc/default/coturn
REALM=mafia-game.uz
# Relay portlari — router'da forward qilinadigan diapazon. Kichik tutamiz:
# har ovoz seansi 1-2 port oladi, 240 port ~120 bir vaqtdagi relay seansi.
RELAY_MIN=49160
RELAY_MAX=49400

log() { printf '\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "sudo bilan ishga tushiring"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE topilmadi"; exit 1; }

# ---------- tarmoq manzillari ----------
PRIV_IP=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 \
          | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1)
PUB_IP=$(curl -s --max-time 10 https://api.ipify.org || true)
[ -n "$PUB_IP" ] || { echo "Tashqi IP aniqlanmadi — internet yo'q?"; exit 1; }
log "Tashqi IP: $PUB_IP   Ichki IP: ${PRIV_IP:-yoq}"

# ---------- o'rnatish ----------
if ! command -v turnserver >/dev/null 2>&1; then
  log "coturn o'rnatilmoqda"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq coturn
else
  log "coturn allaqachon o'rnatilgan"
fi

# ---------- sir ----------
# Sir backend.env da saqlanadi: backend shu sir bilan vaqtinchalik credential
# yasaydi (HMAC-SHA1), coturn esa shu sir bilan uni tekshiradi.
if grep -q '^TURN_SECRET=.\+' "$ENV_FILE"; then
  TURN_SECRET=$(grep '^TURN_SECRET=' "$ENV_FILE" | cut -d= -f2-)
  log "TURN_SECRET allaqachon bor — qayta yaratilmaydi"
else
  TURN_SECRET=$(openssl rand -hex 32)
  cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
  # mavjud bo'sh qatorni ham almashtiramiz
  sed -i '/^TURN_SECRET=/d;/^TURN_HOST=/d' "$ENV_FILE"
  printf '\n# --- TURN (coturn, setup-turn.sh tomonidan qo\x27shildi) ---\nTURN_SECRET=%s\nTURN_HOST=%s\n' \
         "$TURN_SECRET" "$REALM" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "TURN_SECRET yaratildi va $ENV_FILE ga yozildi"
fi

# ---------- TLS sertifikati (turns:5349 uchun) ----------
CERT=""; KEY=""
for d in "/etc/letsencrypt/live/$REALM" /etc/letsencrypt/live/*; do
  if [ -f "$d/fullchain.pem" ] && [ -f "$d/privkey.pem" ]; then
    CERT="$d/fullchain.pem"; KEY="$d/privkey.pem"; break
  fi
done
if [ -n "$CERT" ]; then
  log "Sertifikat topildi: $CERT"
  # coturn `turnserver` foydalanuvchisi ostida ishlaydi — kalitni o'qishi kerak
  if getent group ssl-cert >/dev/null 2>&1; then
    usermod -a -G ssl-cert turnserver 2>/dev/null || true
    chgrp -R ssl-cert /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
    chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
  fi
else
  warn "TLS sertifikati topilmadi — turns:5349 o'chirildi (turn:3478 ishlaydi)"
fi

# ---------- konfiguratsiya ----------
[ -f "$CONF" ] && cp -a "$CONF" "$CONF.bak.$(date +%s)"
{
  echo "# mafia-game.uz ovozli chati uchun TURN. setup-turn.sh yaratgan — qo'lda"
  echo "# tahrirlansa, skriptni qayta ishga tushirish uni qaytaradi."
  echo "listening-port=3478"
  [ -n "$CERT" ] && echo "tls-listening-port=5349"
  echo "fingerprint"
  # Vaqtinchalik credential rejimi: doimiy parol YO'Q, backend HMAC bilan yasaydi
  echo "use-auth-secret"
  echo "static-auth-secret=$TURN_SECRET"
  echo "realm=$REALM"
  echo "server-name=$REALM"
  # NAT: coturn mijozga QAYSI manzilni berishini bilishi kerak
  if [ -n "${PRIV_IP:-}" ]; then
    echo "listening-ip=$PRIV_IP"
    echo "relay-ip=$PRIV_IP"
    echo "external-ip=$PUB_IP/$PRIV_IP"
  else
    echo "external-ip=$PUB_IP"
  fi
  echo "min-port=$RELAY_MIN"
  echo "max-port=$RELAY_MAX"
  if [ -n "$CERT" ]; then
    echo "cert=$CERT"
    echo "pkey=$KEY"
    echo "no-tlsv1"
    echo "no-tlsv1_1"
  fi
  # --- XAVFSIZLIK: eng muhim qism ---
  # TURN — bu proxy. Cheklanmasa, istalgan odam uni ICHKI tarmoqqa kirish uchun
  # ishlatadi: bu serverda Postgres (5432), Redis (6379), Docker tarmoqlari
  # (172.18/172.20) va boshqa loyihalar turadi. Shuning uchun relay faqat
  # OMMAVIY manzillarga ruxsat etiladi.
  echo "no-multicast-peers"
  echo "denied-peer-ip=0.0.0.0-0.255.255.255"
  echo "denied-peer-ip=10.0.0.0-10.255.255.255"
  echo "denied-peer-ip=100.64.0.0-100.127.255.255"
  echo "denied-peer-ip=127.0.0.0-127.255.255.255"
  echo "denied-peer-ip=169.254.0.0-169.254.255.255"
  echo "denied-peer-ip=172.16.0.0-172.31.255.255"
  echo "denied-peer-ip=192.0.0.0-192.0.0.255"
  echo "denied-peer-ip=192.168.0.0-192.168.255.255"
  echo "denied-peer-ip=198.18.0.0-198.19.255.255"
  echo "denied-peer-ip=198.51.100.0-198.51.100.255"
  echo "denied-peer-ip=203.0.113.0-203.0.113.255"
  echo "denied-peer-ip=224.0.0.0-255.255.255.255"
  echo "denied-peer-ip=::1"
  echo "denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
  echo "denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
  # Bir credential bilan nechta seans (suiiste'molni cheklaydi)
  echo "user-quota=12"
  echo "total-quota=1200"
  # Kanal bo'yicha tezlik chegarasi yo'q — ovoz ~40 kbit/s, cheklov kerak emas
  # Telnet CLI ni butunlay o'chiramiz (standart holda 127.0.0.1:5766 da turadi)
  echo "no-cli"
  # Eskirgan/keraksiz narsalar
  echo "no-tcp-relay"
  echo "stale-nonce=600"
  echo "no-software-attribute"
  echo "simple-log"
  echo "log-file=/var/log/turnserver.log"
} > "$CONF"
chmod 640 "$CONF"
log "$CONF yozildi"

# ---------- systemd ----------
if [ -f "$DEFAULTS" ]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' "$DEFAULTS"
  grep -q '^TURNSERVER_ENABLED=1' "$DEFAULTS" || echo 'TURNSERVER_ENABLED=1' >> "$DEFAULTS"
fi
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 2
if systemctl is-active --quiet coturn; then
  log "coturn ishga tushdi"
else
  warn "coturn ishga tushmadi — journalctl -u coturn -n 40"
  exit 1
fi

# ---------- portlarni ochish (host devor) ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -qi active; then
  log "ufw faol — portlar ochilmoqda"
  ufw allow 3478/udp  >/dev/null || true
  ufw allow 3478/tcp  >/dev/null || true
  [ -n "$CERT" ] && ufw allow 5349/tcp >/dev/null || true
  ufw allow "$RELAY_MIN:$RELAY_MAX/udp" >/dev/null || true
else
  log "ufw faol emas — host devorida o'zgarish qilinmadi"
fi

# ---------- tekshiruv ----------
log "Tinglanayotgan portlar"
ss -lnup 2>/dev/null | grep -E ':(3478|5349)' || warn "3478 UDP ko'rinmadi"
ss -lntp 2>/dev/null | grep -E ':(3478|5349)' || true

log "Backend qayta ishga tushirilmoqda (TURN_SECRET ni o'qishi uchun)"
su - sys-admin -c 'cd /srv/mafia && pm2 restart mafia-backend --update-env' >/dev/null 2>&1 \
  || warn "pm2 restart qo'lda kerak: pm2 restart mafia-backend --update-env"

TLS_LINE=""
[ -n "$CERT" ] && TLS_LINE="   5349  TCP   -> $PRIV_IP:5349     (TURN over TLS)"

echo ""
printf '[1;32mTAYYOR.[0m  Endi ROUTERDA port forward qilish kerak (%s -> %s):

' "$PUB_IP" "$PRIV_IP"
echo "   3478  UDP   -> $PRIV_IP:3478     (asosiy TURN)"
echo "   3478  TCP   -> $PRIV_IP:3478     (UDP yopiq tarmoqlar uchun)"
[ -n "$TLS_LINE" ] && echo "$TLS_LINE"
echo "   $RELAY_MIN-$RELAY_MAX UDP -> $PRIV_IP:$RELAY_MIN-$RELAY_MAX   (ovoz oqimi)"
echo ""
echo "Oxirgi diapazon MAJBURIY: usiz TURN credential beradi, lekin ovoz o'tmaydi."
echo ""
echo "Tekshirish:"
echo "  1) sudo tail -f /var/log/turnserver.log     - ulanishlar ko'rinadi"
echo "  2) O'yinda ovozli chatni yoqib, ikki xil tarmoqdan (Wi-Fi + mobil) sinang"
echo "  3) Backend TURN ni ko'rayotganini tekshirish:"
echo "     curl -s localhost:4100/health?key=<ADMIN_ACCESS_KEY>"
echo ""
