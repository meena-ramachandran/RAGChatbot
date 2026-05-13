import jwt from 'jsonwebtoken';
import cookie from 'cookie';

// CONFIG
const TOKEN_NAME = 'token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure:process.env.NODE_ENV=== 'production',
  sameSite: 'lax',
  path: '/',
  maxAge:60 * 60 * 24 * 7, // 7 days
};

// SET TOKEN COOKIE
export function setTokenCookie(res,token) {
  const cookieStr =cookie.serialize(
      TOKEN_NAME,
      token,
      COOKIE_OPTIONS
    );

  res.setHeader('Set-Cookie',cookieStr);
}


// CLEAR TOKEN COOKIE
export function clearTokenCookie( res) {
  const cookieStr =cookie.serialize(TOKEN_NAME,'',{...COOKIE_OPTIONS,maxAge: 0,});
  res.setHeader('Set-Cookie',cookieStr);
}

// GET TOKEN FROM REQUEST
export function getTokenFromReq(req) {
  try {
    const cookies =cookie.parse(req.headers.cookie || '');
    return cookies[TOKEN_NAME];
  } catch {
    return null;
  }
}



// VERIFY JWT
export function verifyToken(token) {
  try {
    return jwt.verify(token,process.env.JWT_SECRET);
  } catch {
    return null;
  }
}


// GET USER FROM REQUEST
export function getUserFromReq(req) {
  try {
    const token =getTokenFromReq(req);
    if (!token) {
      return null;
    }
    const payload =verifyToken(token);
    if (!payload) {
      return null;
    }
    return {
      id:payload.id,
      email:payload.email,
      role:payload.role,
    };
  } catch {
    return null;
  }
}