# DNS Kurulum Rehberi — app.primesimobile.com

## Cloudflare Kullanıyorsanız (Önerilen)

1. cloudflare.com → primesimobile.com → DNS
2. Aşağıdaki kayıtları ekleyin:

| Type  | Name  | Content                    | Proxy   | TTL  |
|-------|-------|----------------------------|---------|------|
| CNAME | app   | primesim-app.vercel.app    | OFF     | Auto |
| CNAME | admin | primesim-admin.vercel.app  | OFF     | Auto |
| CNAME | api   | primesim-api.railway.app   | OFF     | Auto |

> ⚠️ SSL sertifikası için Proxy'yi KAPALI (grey cloud) bırakın

## GoDaddy / Namecheap Kullanıyorsanız

DNS Management panelinde:
- Host: app  | Type: CNAME  | Value: primesim-app.vercel.app
- Host: admin | Type: CNAME | Value: primesim-admin.vercel.app  
- Host: api   | Type: CNAME | Value: primesim-api.railway.app

## Kendi Sunucu (VPS) Kullanıyorsanız

SUNUCU_IP yerine gerçek IP adresinizi yazın:

| Type | Name  | Content     | TTL  |
|------|-------|-------------|------|
| A    | app   | SUNUCU_IP   | 3600 |
| A    | admin | SUNUCU_IP   | 3600 |
| A    | api   | SUNUCU_IP   | 3600 |

Sonra deploy.sh çalıştırın — nginx + SSL otomatik yapılandırılır.

## DNS Yayılma Süresi
- Cloudflare: ~1-5 dakika
- Diğer: ~15-60 dakika (nadiren 48 saat)

## Doğrulama
```bash
# DNS kontrolü
nslookup app.primesimobile.com
dig app.primesimobile.com CNAME

# SSL kontrolü  
curl -I https://app.primesimobile.com
```
