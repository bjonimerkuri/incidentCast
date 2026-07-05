// AI Service using Cloudflare Workers AI
// Provides intelligent incident summaries, auto-categorization, and suggested responses
import { Env } from '../types';

interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AIResponse {
  response?: string;
  text?: string;
}

// Run AI inference using Cloudflare Workers AI
async function runAI(env: Env, messages: AIMessage[]): Promise<string> {
  // Check if AI binding is available
  if (!env.AI) {
    throw new Error('AI binding not configured. Add AI = { binding = "AI" } to wrangler.jsonc');
  }

  try {
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages
    }) as AIResponse;

    return response.response || response.text || '';
  } catch (error) {
    console.error('AI inference error:', error);
    throw error;
  }
}

// Generate a summary for an incident
export async function generateIncidentSummary(
  env: Env,
  incident: {
    title: string;
    status: string;
    impact: string;
    updates: Array<{ status: string; message: string; created_at: string }>;
    components: string[];
  }
): Promise<string> {
  const updatesText = incident.updates
    .map(u => `[${u.status}] ${u.message}`)
    .join('\n');

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `You are an expert technical writer for status pages. Generate concise, professional summaries of incidents for stakeholders. Keep summaries under 100 words. Be clear and factual.`
    },
    {
      role: 'user',
      content: `Summarize this incident:

Title: ${incident.title}
Current Status: ${incident.status}
Impact Level: ${incident.impact}
Affected Components: ${incident.components.join(', ') || 'None specified'}

Timeline of Updates:
${updatesText}

Generate a brief executive summary suitable for stakeholders.`
    }
  ];

  return runAI(env, messages);
}

// Suggest a response for an incident update
export async function suggestIncidentResponse(
  env: Env,
  context: {
    title: string;
    currentStatus: string;
    impact: string;
    previousUpdates: string[];
    targetStatus: string;
  }
): Promise<string> {
  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `You are a technical communicator for a status page. Write clear, professional incident updates. Be empathetic but factual. Keep responses under 150 words. Don't include timestamps.`
    },
    {
      role: 'user',
      content: `Write an incident update for:

Incident: ${context.title}
Moving from status: ${context.currentStatus} → ${context.targetStatus}
Impact: ${context.impact}

Previous updates for context:
${context.previousUpdates.slice(-3).join('\n---\n') || 'This is the first update'}

Write a professional update message for the "${context.targetStatus}" status.`
    }
  ];

  return runAI(env, messages);
}

// Auto-categorize an incident based on description
export async function categorizeIncident(
  env: Env,
  description: string,
  availableComponents: string[]
): Promise<{
  suggestedTitle: string;
  suggestedImpact: 'none' | 'minor' | 'major' | 'critical';
  affectedComponents: string[];
  category: string;
}> {
  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `You are an incident categorization system. Analyze incident descriptions and return JSON with: suggestedTitle (concise title), suggestedImpact (none/minor/major/critical), affectedComponents (array from provided list), category (one of: network, database, api, frontend, authentication, infrastructure, third-party, other). Only return valid JSON.`
    },
    {
      role: 'user',
      content: `Categorize this incident:

Description: ${description}

Available components: ${availableComponents.join(', ')}

Return only JSON in this format:
{
  "suggestedTitle": "Brief title",
  "suggestedImpact": "minor",
  "affectedComponents": ["component1"],
  "category": "api"
}`
    }
  ];

  try {
    const response = await runAI(env, messages);
    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.error('Categorization error:', error);
  }

  // Return defaults if AI fails
  return {
    suggestedTitle: 'Service Issue',
    suggestedImpact: 'minor',
    affectedComponents: [],
    category: 'other'
  };
}

// Generate a post-mortem template
export async function generatePostMortem(
  env: Env,
  incident: {
    title: string;
    impact: string;
    startTime: string;
    endTime: string;
    updates: Array<{ status: string; message: string; created_at: string }>;
    components: string[];
  }
): Promise<string> {
  const duration = new Date(incident.endTime).getTime() - new Date(incident.startTime).getTime();
  const durationMinutes = Math.round(duration / 60000);

  const timeline = incident.updates
    .map(u => `- ${new Date(u.created_at).toLocaleTimeString()}: [${u.status}] ${u.message}`)
    .join('\n');

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `You are a technical writer creating post-mortem reports. Generate professional, blameless post-mortems following the standard format: Summary, Impact, Timeline, Root Cause, Resolution, Action Items. Be specific but concise.`
    },
    {
      role: 'user',
      content: `Generate a post-mortem for:

Incident: ${incident.title}
Impact Level: ${incident.impact}
Duration: ${durationMinutes} minutes
Affected Components: ${incident.components.join(', ')}

Timeline:
${timeline}

Generate a professional post-mortem document with sections for Summary, Impact, Timeline, Root Cause Analysis (suggest based on the updates), Resolution, and Action Items.`
    }
  ];

  return runAI(env, messages);
}

// Analyze component health trends
export async function analyzeHealthTrends(
  env: Env,
  componentHistory: Array<{
    name: string;
    incidents: number;
    totalDowntime: number;
    avgRecoveryTime: number;
  }>
): Promise<string> {
  const data = componentHistory
    .map(c => `${c.name}: ${c.incidents} incidents, ${c.totalDowntime}min downtime, ${c.avgRecoveryTime}min avg recovery`)
    .join('\n');

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `You are a site reliability engineer analyzing system health. Provide brief, actionable insights about component reliability trends. Keep analysis under 200 words.`
    },
    {
      role: 'user',
      content: `Analyze these component health metrics from the past 30 days:

${data}

Provide insights on:
1. Which components need attention
2. Overall reliability trends
3. Recommendations for improvement`
    }
  ];

  return runAI(env, messages);
}

// Simple draft improver for status updates
export async function improveDraft(
  env: Env,
  draft: string,
  context: 'incident' | 'maintenance' | 'announcement'
): Promise<string> {
  const contextInstructions = {
    incident: 'an incident update on a status page. Be professional, empathetic, and clear about what happened and what\'s being done.',
    maintenance: 'a scheduled maintenance notification. Be clear about timing, impact, and what users should expect.',
    announcement: 'a status page announcement. Be informative and professional.'
  };

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `You are a professional technical communicator. Improve the writing quality while preserving the original meaning. Keep the same length or shorter. Don't add information that wasn't in the original.`
    },
    {
      role: 'user',
      content: `Improve this draft for ${contextInstructions[context]}

Original draft:
"${draft}"

Provide only the improved version, nothing else.`
    }
  ];

  return runAI(env, messages);
}
