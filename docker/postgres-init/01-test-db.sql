-- Runs once, on first start of an empty data volume. Separate DB so tests never touch dev data.
CREATE DATABASE taskhub_test OWNER taskhub;
