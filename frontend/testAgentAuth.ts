import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';

async function runTest() {
    console.log('--- Starting Agent Isolation Test ---');

    console.log('1. Registering User A...');
    const regResA = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'userA@test.com', password: 'password123' })
    });

    // Might fail if user already exists, so we ignore error and just login
    console.log('2. Logging in User A...');
    let resA = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'userA@test.com', password: 'password123' })
    });
    const userA = await resA.json();
    const tokenA = userA.token;
    console.log('User A Token:', tokenA ? 'Received' : 'Failed');

    console.log('\n3. Registering User B...');
    const regResB = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'userB@test.com', password: 'password123' })
    });

    console.log('4. Logging in User B...');
    let resB = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'userB@test.com', password: 'password123' })
    });
    const userB = await resB.json();
    const tokenB = userB.token;
    console.log('User B Token:', tokenB ? 'Received' : 'Failed');

    console.log('\n--- Testing Agent Creation & Isolation ---');
    console.log('User A creates Agent A...');
    const agentARes = await fetch(`${BASE_URL}/api/agents`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${tokenA}`
        },
        body: JSON.stringify({
            name: 'Agent A',
            systemPrompt: 'You are Agent A',
            voiceId: 'voice-a',
            startSpeakingPlan: {},
            stopSpeakingPlan: {}
        })
    });
    const agentA = await agentARes.json();
    console.log('Agent A Created:', agentA.id);

    console.log('User B creates Agent B...');
    const agentBRes = await fetch(`${BASE_URL}/api/agents`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${tokenB}`
        },
        body: JSON.stringify({
            name: 'Agent B',
            systemPrompt: 'You are Agent B',
            voiceId: 'voice-b',
            startSpeakingPlan: {},
            stopSpeakingPlan: {}
        })
    });
    const agentB = await agentBRes.json();
    console.log('Agent B Created:', agentB.id);

    console.log('\n--- Fetching Lists ---');
    const listARes = await fetch(`${BASE_URL}/api/agents`, {
        headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    const listA = await listARes.json();
    console.log('User A sees agents:', listA.map(a => a.name));

    const listBRes = await fetch(`${BASE_URL}/api/agents`, {
        headers: { 'Authorization': `Bearer ${tokenB}` }
    });
    const listB = await listBRes.json();
    console.log('User B sees agents:', listB.map(b => b.name));

    if (listA.find(a => a.name === 'Agent B')) console.error('FAIL: User A saw Agent B');
    if (listB.find(b => b.name === 'Agent A')) console.error('FAIL: User B saw Agent A');

    console.log('\n--- Testing Deletion ---');
    console.log('User A tries to delete Agent B (should fail)...');
    const delFailRes = await fetch(`${BASE_URL}/api/agents/${agentB.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    console.log('Delete status:', delFailRes.status, '(expected 404)');

    console.log('User A deletes Agent A (should succeed)...');
    const delSuccessRes = await fetch(`${BASE_URL}/api/agents/${agentA.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${tokenA}` }
    });
    console.log('Delete status:', delSuccessRes.status, '(expected 200)');

    console.log('\n--- Test Complete ---');
}

runTest().catch(console.error);
