# PrimeSIM Mobile — app.primesimobile.com Deploy Paketi

## Adım 1: DNS Kaydı Ekle
Domain yönetim panelinizde (Cloudflare / GoDaddy / Namecheap):

```
Type: CNAME
Name: app
Value: primesim-app.vercel.app
TTL: Auto

Type: CNAME
Name: admin
Value: primesim-admin.vercel.app
TTL: Auto

Type: CNAME
Name: api
Value: primesim-api.railway.app
TTL: Auto
```

## Adım 2: Vercel Deploy
1. vercel.com → New Project → GitHub'dan import
2. Custom Domain: app.primesimobile.com ekle
3. Environment Variables'ı ekle (vercel.env dosyasından)

## Adım 3: Canlı Test
- https://app.primesimobile.com → SuperApp
- https://admin.primesimobile.com → Admin Panel
- https://api.primesimobile.com → REST API
