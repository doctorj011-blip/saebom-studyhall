/* Pure admin rules. No Firebase, browser state or side effects. */
(function(root) {
  'use strict';
  const core = {
    billingEligible(student, month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
      const first = month + '-01';
      const [y, m] = month.split('-').map(Number);
      const last = month + '-' + new Date(y, m, 0).getDate();
      return (!student.startDate || student.startDate <= last)
        && (!student.withdrawAt || student.withdrawAt >= first);
    },
    baseFee(config) {
      const value = Number(config && config.defaultFee);
      if (!config || config.defaultFee == null || config.defaultFee === '' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('기본 이용료를 확인하고 저장해 주세요.');
      }
      return value;
    },
    bill(student, base, discount) {
      const flat = Number(student.fee) > 0;
      const fee = flat ? Number(student.fee) : base;
      const won = flat ? 0 : Number(discount || 0);
      if (![fee, won].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('이용료 또는 할인액이 올바르지 않습니다.');
      return {base: fee, won, pay: Math.max(0, fee - won), flat};
    },
    async mapLimit(items, concurrency, task) {
      const results = new Array(items.length);
      let next = 0;
      await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
        while (next < items.length) {
          const i = next++;
          results[i] = await task(items[i], i);
        }
      }));
      return results;
    },
    latestRecords(records) {
      const byStudent = new Map();
      for (const record of records) {
        const key = record.uid || String(record.seat || record.studentName);
        const old = byStudent.get(key);
        if (!old || Number(record.inTs || 0) >= Number(old.inTs || 0)) byStudent.set(key, record);
      }
      return [...byStudent.values()];
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.SaebomAdminCore = core;
})(typeof window !== 'undefined' ? window : globalThis);
