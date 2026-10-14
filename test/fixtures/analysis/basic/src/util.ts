import axios from 'axios';
import { describe } from 'vitest';

export function util(value: string): void {
  describe('util', () => {
    console.log(value);
  });
}
