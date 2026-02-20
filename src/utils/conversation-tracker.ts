/**
 * Conversation Tracker - Used to capture user questions and Claude responses
 */

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './paths';

interface ConversationMessage {
    type: 'user' | 'claude';
    content: string;
    timestamp: string;
}

interface ConversationSession {
    created: string;
    messages: ConversationMessage[];
}

interface ConversationMap {
    [sessionId: string]: ConversationSession;
}

interface RecentConversation {
    userQuestion: string;
    claudeResponse: string;
}

class ConversationTracker {
    conversationPath: string;

    constructor() {
        this.conversationPath = path.join(PROJECT_ROOT, 'src/data/conversations.json');
        this.ensureDataDir();
    }

    ensureDataDir(): void {
        const dir = path.dirname(this.conversationPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    // Record user question
    recordUserMessage(sessionId: string, message: string): void {
        const conversations = this.loadConversations();
        if (!conversations[sessionId]) {
            conversations[sessionId] = {
                created: new Date().toISOString(),
                messages: []
            };
        }

        conversations[sessionId].messages.push({
            type: 'user',
            content: message,
            timestamp: new Date().toISOString()
        });

        this.saveConversations(conversations);
    }

    // Record Claude response
    recordClaudeResponse(sessionId: string, response: string): void {
        const conversations = this.loadConversations();
        if (!conversations[sessionId]) {
            conversations[sessionId] = {
                created: new Date().toISOString(),
                messages: []
            };
        }

        conversations[sessionId].messages.push({
            type: 'claude',
            content: response,
            timestamp: new Date().toISOString()
        });

        this.saveConversations(conversations);
    }

    // Get recent conversation content
    getRecentConversation(sessionId: string, limit: number = 2): RecentConversation {
        const conversations = this.loadConversations();
        const session = conversations[sessionId];

        if (!session || !session.messages.length) {
            return { userQuestion: '', claudeResponse: '' };
        }

        const messages = session.messages.slice(-limit * 2); // Get recent user-Claude conversation
        let userQuestion = '';
        let claudeResponse = '';

        // Find most recent user question and Claude response from back to front
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.type === 'claude' && !claudeResponse) {
                claudeResponse = msg.content;
            } else if (msg.type === 'user' && !userQuestion) {
                userQuestion = msg.content;
            }

            if (userQuestion && claudeResponse) break;
        }

        return {
            userQuestion: userQuestion || 'Unrecorded user question',
            claudeResponse: claudeResponse || 'Unrecorded Claude response'
        };
    }

    // Clean up expired conversations (older than 7 days)
    cleanupOldConversations(): number {
        const conversations = this.loadConversations();
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const cleaned: ConversationMap = {};
        for (const [sessionId, session] of Object.entries(conversations)) {
            const created = new Date(session.created);
            if (created > sevenDaysAgo) {
                cleaned[sessionId] = session;
            }
        }

        this.saveConversations(cleaned);
        return Object.keys(conversations).length - Object.keys(cleaned).length;
    }

    loadConversations(): ConversationMap {
        if (!fs.existsSync(this.conversationPath)) {
            return {};
        }

        try {
            return JSON.parse(fs.readFileSync(this.conversationPath, 'utf8'));
        } catch (error) {
            console.error('Failed to load conversations:', error);
            return {};
        }
    }

    saveConversations(conversations: ConversationMap): void {
        try {
            fs.writeFileSync(this.conversationPath, JSON.stringify(conversations, null, 2));
        } catch (error) {
            console.error('Failed to save conversations:', error);
        }
    }
}

export = ConversationTracker;
