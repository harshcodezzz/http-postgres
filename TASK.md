# Repository bug fixes

- [x] 1. Immediate queries report an uncertain outcome and its cause after SQL is sent. TypeScript check passed.
- [x] 2. Save batch results before commit and retry the final status update. Existing records remain readable. TypeScript check passed.
- [x] 3. The first shutdown signal drains accepted work. A second signal forces exit. TypeScript check passed.
- [x] 4. Saved batches use the database OID for lookup and deletion across a rename. TypeScript check passed.
- [x] 5. Treat PostgreSQL ERROR replies to COMMIT as definite rollbacks. TypeScript check passed.
- [x] 6. Retain connection slots while interrupted PostgreSQL backends can still be active. TypeScript check passed.
- [x] 7. Verify a unique live query session from the administrative PostgreSQL connection. TypeScript check passed.
- [x] 8. Check for existing transaction storage before issuing creation commands. TypeScript check passed.
- [x] 9. Detect COPY stream responses and return an explicit error. TypeScript check passed.
- [x] 10. Preserve numeric array dimensions and exact decimal strings in lossless mode. TypeScript check passed.
- [x] 11. Return database metadata with size omitted when PostgreSQL denies access to it. TypeScript check passed.
- [x] 12. Add a working link and document how to rebind existing keys without replacing their secrets. Build passed.
