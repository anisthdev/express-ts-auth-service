import type { Request, Response } from 'express';
import httpStatus from 'http-status';
import { v4 as uuidv4 } from 'uuid';
import * as argon2 from 'argon2';
import jwt, { JwtPayload } from 'jsonwebtoken';
import prismaClient from '../config/prisma';
import type {
  TypedRequest,
  UserLoginCredentials,
  UserSignUpCredentials,
} from '../types/types';
import {
  createAccessToken,
  createRefreshToken,
} from '../utils/generateTokens.util';
import config from '../config/config';

import {
  clearRefreshTokenCookieConfig,
  refreshTokenCookieConfig,
} from '../config/cookieConfig';

import { sendVerifyEmail } from '../utils/sendEmail.util';
import logger from '../middleware/logger';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const { verify } = jwt;

/**
 * Handles Signup
 * @param req
 * @param res
 * @returns
 */
export const handleSingUp = async (
  req: TypedRequest<UserSignUpCredentials>,
  res: Response
) => {
  const { username, email, password } = req.body;

  // check req.body values
  if (!username || !email || !password) {
    return res.status(httpStatus.BAD_REQUEST).json({
      message: 'Username, email and password are required!',
    });
  }

  const checkUserEmail = await prismaClient.user.findUnique({
    where: {
      email: email,
    },
  });

  if (checkUserEmail) return res.sendStatus(httpStatus.CONFLICT); // email is already in db

  try {
    const hashedPassword = await argon2.hash(password as string);

    const newUser = await prismaClient.user.create({
      data: {
        name: username,
        email: email,
        password: hashedPassword,
      },
    });

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 3600000); // Token expires in 1 hour
    await prismaClient.emailVerificationToken.create({
      data: {
        token: token,
        expiresAt: expiresAt,
        userId: newUser.id,
      },
    });

    // Send an email with the verification link
    sendVerifyEmail(email, token);

    res.status(httpStatus.CREATED).json({ message: 'New user created' });
  } catch (err) {
    res.sendStatus(httpStatus.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Handles Login
 * @param req
 * @param res
 * @returns
 */
export const handleLogin = async (
  req: TypedRequest<UserLoginCredentials>,
  res: Response
) => {
  const cookies = req.cookies;

  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(httpStatus.BAD_REQUEST)
      .json({ message: 'Email and password are required!' });
  }

  const user = await prismaClient.user.findUnique({
    where: {
      email: email,
    },
  });

  if (!user) return res.sendStatus(httpStatus.UNAUTHORIZED);

  // check if email is verified
  if (!user.emailVerified) {
    res.send(httpStatus.UNAUTHORIZED).json({
      message: 'Your email is not verified! Please confirm your email!',
    });
  }

  // check password
  try {
    if (await argon2.verify(user.password, password)) {
      // if there is a refresh token in the req.cookie, then we need to check if this
      // refresh token exists in the database and belongs to the current user than we need to delete it
      // if the token does not belong to the current user, then we delete all refresh tokens
      // of the user stored in the db to be on the safe site
      // we also clear the cookie in both cases
      if (cookies?.jid) {
        // check if the given refresh token is from the current user
        const checkRefreshToken = await prismaClient.refreshToken.findUnique({
          where: {
            token: cookies.jid,
          },
        });

        // if this token does not exists int the database or belongs to another user,
        // then we clear all refresh tokens from the user in the db
        if (!checkRefreshToken || checkRefreshToken.userId != user.id) {
          await prismaClient.refreshToken.deleteMany({
            where: {
              userId: user.id,
            },
          });
        } else {
          // else everything is fine and we just need to delete the one token
          await prismaClient.refreshToken.delete({
            where: {
              token: cookies.jid,
            },
          });
        }

        // also clear the refresh token in the cookie
        res.clearCookie(
          config.refresh_token_cookie_name,
          clearRefreshTokenCookieConfig
        );
      }

      const accessToken = createAccessToken(user.id);

      const newRefreshToken = createRefreshToken(user.id);

      // store new refresh token in db
      const dbRefreshToken = await prismaClient.refreshToken.create({
        data: {
          token: newRefreshToken,
          userId: user.id,
        },
      });

      console.log(dbRefreshToken);

      // save refresh token in cookie
      res.cookie(
        config.refresh_token_cookie_name,
        newRefreshToken,
        refreshTokenCookieConfig
      );

      // send access token per json to user so it can be stored in the localStorage
      return res.json({ accessToken });
    } else {
      return res.sendStatus(httpStatus.UNAUTHORIZED);
    }
  } catch (err) {
    return res.sendStatus(httpStatus.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Handles Logout
 * @param req
 * @param res
 * @returns
 */
export const handleLogout = async (req: TypedRequest, res: Response) => {
  const cookies = req.cookies;

  if (!cookies?.jid) return res.sendStatus(httpStatus.NO_CONTENT); //No content
  const refreshToken = cookies.jid;

  // Is refreshToken in db?
  const foundRft = await prismaClient.refreshToken.findUnique({
    where: { token: refreshToken },
  });

  if (!foundRft) {
    res.clearCookie(
      config.refresh_token_cookie_name,
      clearRefreshTokenCookieConfig
    );
    return res.sendStatus(httpStatus.NO_CONTENT);
  }

  // Delete refreshToken in db
  await prismaClient.refreshToken.delete({
    where: { token: refreshToken },
  });

  res.clearCookie(
    config.refresh_token_cookie_name,
    clearRefreshTokenCookieConfig
  );
  res.sendStatus(httpStatus.NO_CONTENT);
};

/**
 * Handles refreshing for access tokens
 * @param req
 * @param res
 * @returns
 */
export const handleRefresh = async (req: Request, res: Response) => {
  const token: string | undefined =
    req.cookies[config.refresh_token_cookie_name];

  if (!token) return res.sendStatus(httpStatus.UNAUTHORIZED);

  const refreshToken = token;

  // clear refresh cookie
  res.clearCookie(
    config.refresh_token_cookie_name,
    clearRefreshTokenCookieConfig
  );
  // check if refresh token is in db
  const foundRefreshToken = await prismaClient.refreshToken.findUnique({
    where: {
      token: refreshToken,
    },
  });

  // Detected refresh token reuse!
  if (!foundRefreshToken) {
    verify(
      refreshToken,
      process.env.REFRESH_TOKEN_SECRET,
      async (err: unknown, payload: JwtPayload) => {
        if (err) return res.sendStatus(httpStatus.FORBIDDEN);
        logger.warn('attempted refresh token reuse!');
        await prismaClient.refreshToken.deleteMany({
          where: {
            userId: payload.userId,
          },
        });
      }
    );
    return res.sendStatus(httpStatus.FORBIDDEN);
  }

  // delete from db
  await prismaClient.refreshToken.delete({
    where: {
      token: refreshToken,
    },
  });

  // evaluate jwt
  verify(
    refreshToken,
    process.env.REFRESH_TOKEN_SECRET,
    async (err: unknown, payload: JwtPayload) => {
      if (err || foundRefreshToken.userId !== payload.userId)
        return res.sendStatus(httpStatus.FORBIDDEN);

      // Refresh token was still valid
      const accessToken = createAccessToken(payload.userId);

      const newRefreshToken = createRefreshToken(payload.userId);

      // add refresh token to db
      await prismaClient.refreshToken
        .create({
          data: {
            token: newRefreshToken,
            userId: payload.userId,
          },
        })
        .catch((err) => {
          logger.error(err);
        });

      // Creates Secure Cookie with refresh token
      res.cookie(
        config.refresh_token_cookie_name,
        newRefreshToken,
        refreshTokenCookieConfig
      );

      res.json({ accessToken });
    }
  );
};
