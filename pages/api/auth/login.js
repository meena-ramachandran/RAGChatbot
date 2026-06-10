import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import supabaseServer from '../../../lib/supabaseServer';
import { setTokenCookie } from '../../../lib/auth';

export default async function
handler(req, res) {
  if (req.method !== 'POST') {
    return res
      .status(405)
      .json({
        error:
          'Method not allowed',
      });
  }
  try {
    const {email,password} = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({
          error:
            'Missing credentials',
        });
    }
    const {
      data: user,
      error,
    } =await supabaseServer
        .from('users')
        .select(`id,email,password_hash,role,is_active`)
        .eq('email', email)
        .single();

    if (error ||!user) {
      return res.status(401).json({
          error:'Invalid credentials',
        });
    }


    if (!user.is_active) {
      return res
        .status(403)
        .json({
          error:
            'Account disabled',
        });
    }

    const validPassword =
      await bcrypt.compare(password,user.password_hash);
    if (!validPassword) {
      return res
        .status(401)
        .json({
          error:
            'Invalid credentials',
        });
    }


    const token =jwt.sign(
        {
          id:user.id,
          email:user.email,
          role:user.role,
        },
        process.env.JWT_SECRET,
        {
          expiresIn:'7d',
        }
      );


    setTokenCookie(res,token);
    return res
      .status(200)
      .json({
        success: true,
        user: {
          id:user.id,
          email:user.email,
          role:user.role,
        },
      });
  } catch (err) {
    console.error(
      'Login error:',
      err
    );

    return res
      .status(500)
      .json({
        error:'Internal server error',
      });
  }
}