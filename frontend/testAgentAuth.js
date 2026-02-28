"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var node_fetch_1 = __importDefault(require("node-fetch"));
var BASE_URL = 'http://localhost:3000';
function runTest() {
    return __awaiter(this, void 0, void 0, function () {
        var regResA, resA, userA, tokenA, regResB, resB, userB, tokenB, agentARes, agentA, agentBRes, agentB, listARes, listA, listBRes, listB, delFailRes, delSuccessRes;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log('--- Starting Agent Isolation Test ---');
                    console.log('1. Registering User A...');
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/auth/register"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: 'userA@test.com', password: 'password123' })
                        })];
                case 1:
                    regResA = _a.sent();
                    // Might fail if user already exists, so we ignore error and just login
                    console.log('2. Logging in User A...');
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/auth/login"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: 'userA@test.com', password: 'password123' })
                        })];
                case 2:
                    resA = _a.sent();
                    return [4 /*yield*/, resA.json()];
                case 3:
                    userA = _a.sent();
                    tokenA = userA.token;
                    console.log('User A Token:', tokenA ? 'Received' : 'Failed');
                    console.log('\n3. Registering User B...');
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/auth/register"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: 'userB@test.com', password: 'password123' })
                        })];
                case 4:
                    regResB = _a.sent();
                    console.log('4. Logging in User B...');
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/auth/login"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: 'userB@test.com', password: 'password123' })
                        })];
                case 5:
                    resB = _a.sent();
                    return [4 /*yield*/, resB.json()];
                case 6:
                    userB = _a.sent();
                    tokenB = userB.token;
                    console.log('User B Token:', tokenB ? 'Received' : 'Failed');
                    console.log('\n--- Testing Agent Creation & Isolation ---');
                    console.log('User A creates Agent A...');
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/agents"), {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': "Bearer ".concat(tokenA)
                            },
                            body: JSON.stringify({
                                name: 'Agent A',
                                systemPrompt: 'You are Agent A',
                                voiceId: 'voice-a',
                                startSpeakingPlan: {},
                                stopSpeakingPlan: {}
                            })
                        })];
                case 7:
                    agentARes = _a.sent();
                    return [4 /*yield*/, agentARes.json()];
                case 8:
                    agentA = _a.sent();
                    console.log('Agent A Created:', agentA.id);
                    console.log('User B creates Agent B...');
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/agents"), {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': "Bearer ".concat(tokenB)
                            },
                            body: JSON.stringify({
                                name: 'Agent B',
                                systemPrompt: 'You are Agent B',
                                voiceId: 'voice-b',
                                startSpeakingPlan: {},
                                stopSpeakingPlan: {}
                            })
                        })];
                case 9:
                    agentBRes = _a.sent();
                    return [4 /*yield*/, agentBRes.json()];
                case 10:
                    agentB = _a.sent();
                    console.log('Agent B Created:', agentB.id);
                    console.log('\n--- Fetching Lists ---');
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/agents"), {
                            headers: { 'Authorization': "Bearer ".concat(tokenA) }
                        })];
                case 11:
                    listARes = _a.sent();
                    return [4 /*yield*/, listARes.json()];
                case 12:
                    listA = _a.sent();
                    console.log('User A sees agents:', listA.map(function (a) { return a.name; }));
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/agents"), {
                            headers: { 'Authorization': "Bearer ".concat(tokenB) }
                        })];
                case 13:
                    listBRes = _a.sent();
                    return [4 /*yield*/, listBRes.json()];
                case 14:
                    listB = _a.sent();
                    console.log('User B sees agents:', listB.map(function (b) { return b.name; }));
                    if (listA.find(function (a) { return a.name === 'Agent B'; }))
                        console.error('FAIL: User A saw Agent B');
                    if (listB.find(function (b) { return b.name === 'Agent A'; }))
                        console.error('FAIL: User B saw Agent A');
                    console.log('\n--- Testing Deletion ---');
                    console.log('User A tries to delete Agent B (should fail)...');
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/agents/").concat(agentB.id), {
                            method: 'DELETE',
                            headers: { 'Authorization': "Bearer ".concat(tokenA) }
                        })];
                case 15:
                    delFailRes = _a.sent();
                    console.log('Delete status:', delFailRes.status, '(expected 404)');
                    console.log('User A deletes Agent A (should succeed)...');
                    return [4 /*yield*/, (0, node_fetch_1.default)("".concat(BASE_URL, "/api/agents/").concat(agentA.id), {
                            method: 'DELETE',
                            headers: { 'Authorization': "Bearer ".concat(tokenA) }
                        })];
                case 16:
                    delSuccessRes = _a.sent();
                    console.log('Delete status:', delSuccessRes.status, '(expected 200)');
                    console.log('\n--- Test Complete ---');
                    return [2 /*return*/];
            }
        });
    });
}
runTest().catch(console.error);
