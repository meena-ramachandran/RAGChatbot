import bcrypt from 'bcryptjs';

import jwt from 'jsonwebtoken';

import supabaseServer
  from '../../../lib/supabaseServer';

import {
  setTokenCookie
} from '../../../lib/auth';


export default async function
handler(req, res) {

  if (req.method !== 'POST') {

    return res
      .status(405)
      .end();
  }

  try {

    const {
      email,
      password
    } = req.body;


   
    // VALIDATION

    if (!email ||!password) {
      return res
        .status(400)
        .json({
          error:
            'Missing credentials'
        });
    }


    if (password.length < 8) {
      return res
        .status(400)
        .json({
          error:
            'Password too short'
        });
    }


    // =========================
    // DUPLICATE CHECK
    // =========================

    const {
      data: existingUser
    } =
      await supabaseServer

        .from('users')

        .select('id')

        .eq('email', email)

        .single();

    if (existingUser) {

      return res
        .status(409)
        .json({
          error:
            'Email already exists'
        });
    }



    // HASH PASSWORD
    const hash =await bcrypt.hash(password,12);



    // INSERT USER
    const {data,error} =
      await supabaseServer.from('users')
        .insert([{
          email,
          password_hash:
            hash,
        }])
        .select()
        .single();
    if (error) {
      console.error(
        'Registration failed:',
        error.message
      );

      return res
        .status(400)
        .json({
          error:
            'Registration failed'
        });
    }



    // JWT
    const token =jwt.sign(
        {
          id:data.id,
          email:data.email,
          role:data.role,
        }, process.env.JWT_SECRET,
        {
          expiresIn:'7d'
        }
      );



    // COOKIE
    setTokenCookie(res,token);
    return res
      .status(201)
      .json({
        user: {
          id:data.id,
          email:data.email,
          role:data.role,
        },
      });

  } catch (err) {

    console.error('Register API error:',err);
    return res
      .status(500)
      .json({
        error:
          'Internal server error'
      });
  }
}