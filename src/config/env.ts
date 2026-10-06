import 'dotenv/config';

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

export const env = {
  port,
  databasePath: process.env.DATABASE_PATH ?? './data/app.sqlite',
  everyN: Number(process.env.REWARD_EVERY_N_ORDERS ?? 5),
  percent: Number(process.env.REWARD_DISCOUNT_PERCENT ?? 10),
};

if (!Number.isSafeInteger(env.everyN) || env.everyN < 1 || !Number.isInteger(env.percent) || env.percent < 1 || env.percent > 100) throw new Error('REWARD_EVERY_N_ORDERS must be a positive safe integer and REWARD_DISCOUNT_PERCENT an integer from 1 to 100');

