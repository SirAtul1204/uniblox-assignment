import { products } from './schema';
import type { Db } from './index';
import { parseMoney } from '../utils/money';

export const seedProducts = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Notebook', price: '200.34', inventory: 100 },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Pen', price: '25.50', inventory: 100 },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Coffee Mug', price: '349.99', inventory: 30 },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Backpack', price: '1499.00', inventory: 10 },
  { id: '00000000-0000-4000-8000-000000000005', name: 'Limited Edition Print', price: '999.95', inventory: 2 },
];
export function seed(db: Db) {
  db.transaction(tx => {
    for (const { price, ...product } of seedProducts) tx.insert(products).values({ ...product, priceMinor: parseMoney(price) }).onConflictDoNothing().run();
  }, { behavior: 'immediate' });
}
