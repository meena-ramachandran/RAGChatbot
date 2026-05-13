import {
  clearTokenCookie
} from '../../../lib/auth';

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

  clearTokenCookie(res);

  return res
    .status(200)
    .json({
      success: true,
    });
}