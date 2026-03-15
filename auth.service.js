/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Auth Service — Google OAuth + Apple Sign In                    ║
 * ║  PrimeSIM Mobile — app.primesimobile.com                        ║
 * ║                                                                  ║
 * ║  Uses NextAuth.js v5 (Auth.js) — works with Next.js App Router  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Install: npm install next-auth@5 @auth/prisma-adapter
 */

// ────────────────────────────────────────────────────────────────
// auth.js  (root of Next.js project)
// ────────────────────────────────────────────────────────────────

const NextAuth = require('next-auth');
const Google   = require('next-auth/providers/google');
const Apple    = require('next-auth/providers/apple');
const Credentials = require('next-auth/providers/credentials');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const { handlers, signIn, signOut, auth } = NextAuth({
  secret: process.env.NEXTAUTH_SECRET,

  providers: [
    // ── Google OAuth ──────────────────────────────────────────
    Google({
      clientId:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          prompt:        'consent',
          access_type:   'offline',
          response_type: 'code',
        },
      },
    }),

    // ── Apple Sign In ─────────────────────────────────────────
    Apple({
      clientId:     process.env.APPLE_ID,
      clientSecret: generateAppleSecret(),   // JWT signed with Apple key
    }),

    // ── Email + Password ──────────────────────────────────────
    Credentials({
      name: 'Email',
      credentials: {
        email:    { label: 'Email',    type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const { email, password } = credentials;
        if (!email || !password) return null;

        // Fetch user from DB (replace with your DB)
        // const user = await db.users.findByEmail(email);
        // if (!user) return null;
        // const valid = await bcrypt.compare(password, user.passwordHash);
        // if (!valid) return null;

        // DEMO: accept any credentials
        return { id: '1', email, name: email.split('@')[0], role: 'user' };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user, account }) {
      if (user)    token.userId   = user.id;
      if (account) token.provider = account.provider;
      return token;
    },
    async session({ session, token }) {
      session.user.id       = token.userId;
      session.user.provider = token.provider;
      return session;
    },
    async signIn({ user, account, profile }) {
      // Auto-create user on first social login
      // await db.users.upsert({ email: user.email, provider: account.provider });
      return true;
    },
  },

  pages: {
    signIn:  '/login',
    signOut: '/logout',
    error:   '/login?error=1',
  },

  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 }, // 30 days
});

// ────────────────────────────────────────────────────────────────
// Apple Client Secret Generator
// Apple requires a JWT signed with your private key
// ────────────────────────────────────────────────────────────────
function generateAppleSecret() {
  if (!process.env.APPLE_PRIVATE_KEY) return '';
  try {
    return jwt.sign({}, process.env.APPLE_PRIVATE_KEY, {
      algorithm: 'ES256',
      expiresIn: '180d',
      audience:  'https://appleid.apple.com',
      issuer:    process.env.APPLE_TEAM_ID,
      subject:   process.env.APPLE_ID,
      keyid:     process.env.APPLE_KEY_ID,
    });
  } catch (e) {
    console.error('Apple secret generation failed:', e.message);
    return '';
  }
}

// ────────────────────────────────────────────────────────────────
// Admin JWT (separate from user auth)
// For admin.primesimobile.com access
// ────────────────────────────────────────────────────────────────
function generateAdminToken(adminId, role = 'admin') {
  return jwt.sign(
    { adminId, role, iss: 'admin.primesimobile.com' },
    process.env.ADMIN_SECRET_KEY,
    { expiresIn: '12h' }
  );
}

function verifyAdminToken(token) {
  return jwt.verify(token, process.env.ADMIN_SECRET_KEY);
}

// Admin auth middleware
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.admin = verifyAdminToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { handlers, signIn, signOut, auth, generateAdminToken, verifyAdminToken, requireAdmin };
