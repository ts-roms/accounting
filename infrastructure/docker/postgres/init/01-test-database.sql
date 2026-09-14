-- Separate database for API integration tests so they never touch dev data.
CREATE DATABASE accounting_test OWNER accounting;
