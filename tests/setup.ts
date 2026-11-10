// Integration tests run against TEST_DATABASE_URL (a disposable database whose name ends in _test).
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET ??= "test-secret-test-secret";
