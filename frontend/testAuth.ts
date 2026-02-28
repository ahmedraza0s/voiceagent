import axios from 'axios';

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log('Starting authentication tests...\n');
    let testUserEmail = `test_${Date.now()}@example.com`;
    let testPassword = 'password123';
    let token = '';

    try {
        // 1. Test Registration
        console.log(`[TEST 1] Registering user ${testUserEmail}...`);
        const regRes = await axios.post(`${BASE_URL}/api/auth/register`, {
            email: testUserEmail,
            password: testPassword
        });
        if (regRes.data.success) {
            console.log('✅ Registration successful:', regRes.data.user);
        } else {
            throw new Error('Registration failed');
        }

        // 2. Test Login
        console.log(`\n[TEST 2] Logging in user ${testUserEmail}...`);
        const loginRes = await axios.post(`${BASE_URL}/api/auth/login`, {
            email: testUserEmail,
            password: testPassword
        });
        if (loginRes.data.success && loginRes.data.token) {
            console.log('✅ Login successful. Token received.');
            token = loginRes.data.token;
        } else {
            throw new Error('Login failed');
        }

        // 3. Test Protected Route without token
        console.log(`\n[TEST 3] Accessing protected route WITHOUT token...`);
        try {
            await axios.get(`${BASE_URL}/api/agents`);
            console.error('❌ Expected to fail, but succeeded.');
            process.exit(1);
        } catch (error: any) {
            if (error.response && error.response.status === 401) {
                console.log('✅ Access denied as expected (401).');
            } else {
                throw error;
            }
        }

        // 4. Test Protected Route with token
        console.log(`\n[TEST 4] Accessing protected route WITH token...`);
        const protectedRes = await axios.get(`${BASE_URL}/api/agents`, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        console.log('✅ Access granted to protected route. Agents count:', protectedRes.data.length);

        // 5. Test Logout
        console.log(`\n[TEST 5] Logging out...`);
        const logoutRes = await axios.post(`${BASE_URL}/api/auth/logout`, {});
        if (logoutRes.data.success) {
            console.log('✅ Logout API returned success message.');
        } else {
            throw new Error('Logout failed');
        }

        console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
        process.exit(0);

    } catch (error: any) {
        console.error('\n❌ TEST FAILED:', error.response ? error.response.data : error.message);
        process.exit(1);
    }
}

runTests();
