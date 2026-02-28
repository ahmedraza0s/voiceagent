-- Migration script to create users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Optional: Create a default admin user if it doesn't exist
-- Password: "password123" (hashed version)
-- INSERT INTO users (email, password_hash) 
-- VALUES ('admin@example.com', '$2a$10$X3oX3z2D3W6Y6K1W1W1W1u1W1W1W1W1W1W1W1W1W1W1W1W1W1W1') 
-- ON CONFLICT (email) DO NOTHING;
