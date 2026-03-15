#!/bin/bash
# PrimeSIM Mobile — app.primesimobile.com Otomatik Deploy Script
# Kullanım: chmod +x deploy.sh && ./deploy.sh

set -e
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}   PrimeSIM Mobile — app.primesimobile.com Deploy${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── 1. DNS Kontrol ─────────────────────────────────────
echo -e "${YELLOW}[1/7] DNS kontrol ediliyor...${NC}"
if host app.primesimobile.com > /dev/null 2>&1; then
    echo -e "${GREEN}✓ app.primesimobile.com DNS kaydı bulundu${NC}"
else
    echo -e "${RED}✗ app.primesimobile.com DNS kaydı bulunamadı${NC}"
    echo "  → Domain yönetim panelinizde CNAME kaydı ekleyin:"
    echo "    app  CNAME  primesim-app.vercel.app"
    echo ""
    read -p "DNS kaydı eklediniz mi? (e/h): " dns_ok
    if [ "$dns_ok" != "e" ]; then
        echo "DNS kaydını ekleyip tekrar çalıştırın."
        exit 1
    fi
fi

# ── 2. .env Kontrol ─────────────────────────────────────
echo -e "${YELLOW}[2/7] Environment değişkenleri kontrol ediliyor...${NC}"
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo -e "${RED}✗ .env dosyası bulunamadı — .env.example kopyalandı${NC}"
    echo "  → .env dosyasını doldurun ve tekrar çalıştırın"
    exit 1
fi

required_vars=("STRIPE_SECRET_KEY" "ESIMACCESS_API_KEY" "ANTHROPIC_API_KEY" "DATABASE_URL" "NEXTAUTH_SECRET")
missing=0
for var in "${required_vars[@]}"; do
    if grep -q "BURAYA_EKLE" .env 2>/dev/null && grep "$var" .env | grep -q "BURAYA_EKLE"; then
        echo -e "${RED}  ✗ $var henüz doldurulmamış${NC}"
        missing=1
    fi
done
if [ $missing -eq 1 ]; then
    echo "  → .env dosyasını doldurun"
    exit 1
fi
echo -e "${GREEN}✓ Environment değişkenleri hazır${NC}"

# ── 3. Node.js & npm ────────────────────────────────────
echo -e "${YELLOW}[3/7] Bağımlılıklar yükleniyor...${NC}"
if ! command -v node &> /dev/null; then
    echo "Node.js yükleniyor..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo -e "${GREEN}✓ Node.js $(node -v) hazır${NC}"

npm install --production --silent
echo -e "${GREEN}✓ npm bağımlılıkları yüklendi${NC}"

# ── 4. Build ─────────────────────────────────────────────
echo -e "${YELLOW}[4/7] Next.js build alınıyor...${NC}"
npm run build
echo -e "${GREEN}✓ Build başarılı${NC}"

# ── 5. PM2 ile Çalıştır ──────────────────────────────────
echo -e "${YELLOW}[5/7] PM2 ile uygulama başlatılıyor...${NC}"
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2 --silent
fi
pm2 delete primesim-app 2>/dev/null || true
pm2 start npm --name "primesim-app" -- start
pm2 save
echo -e "${GREEN}✓ primesim-app PM2'de çalışıyor (port 3000)${NC}"

# ── 6. SSL Sertifikası ─────────────────────────────────
echo -e "${YELLOW}[6/7] SSL sertifikası oluşturuluyor...${NC}"
if ! command -v certbot &> /dev/null; then
    sudo snap install --classic certbot
fi
sudo certbot --nginx -d app.primesimobile.com -d admin.primesimobile.com -d api.primesimobile.com \
    --non-interactive --agree-tos -m admin@primesimobile.com
echo -e "${GREEN}✓ SSL sertifikası aktif${NC}"

# ── 7. nginx Konfigürasyon ─────────────────────────────
echo -e "${YELLOW}[7/7] nginx yapılandırılıyor...${NC}"
sudo cp nginx.conf /etc/nginx/sites-available/primesimobile.conf
sudo ln -sf /etc/nginx/sites-available/primesimobile.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
echo -e "${GREEN}✓ nginx yapılandırıldı${NC}"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}   DEPLOY TAMAMLANDI!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "   🌐 SuperApp   → https://app.primesimobile.com"
echo "   ⚙️  Admin      → https://admin.primesimobile.com"
echo "   🔌 API        → https://api.primesimobile.com"
echo "   ❤️  Health     → https://api.primesimobile.com/health"
echo ""
