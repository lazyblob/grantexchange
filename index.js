const express = require('express');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const NodeCache = require('node-cache'); // Add this for caching

const app = express();
const port = process.env.PORT || 8080;
const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour

app.get('/', async (req, res) => {
  try {
    console.log('Request received. Loading credentials...');
    const credentials = {
      client_email: process.env.GA_CLIENT_EMAIL,
      private_key: process.env.GA_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    };
    console.log('Credentials: email ok?', !!credentials.client_email, 'key ok?', !!credentials.private_key);

    console.log('Initializing GA client...');
    const client = new BetaAnalyticsDataClient({ credentials });
    console.log('GA Client ok.');

    const PROPERTY_ID = process.env.PROPERTY_ID;
    console.log('Property ID:', PROPERTY_ID);

    // Check cache first
    const cachedUsers = cache.get('activeUsers');
    if (cachedUsers) {
      console.log('Returning cached active users:', cachedUsers);
      res.send(cachedUsers.toString());
      return;
    }

    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      metrics: [{ name: 'activeUsers' }],  // Changed to activeUsers for engaged users
    });
    console.log('Response rows:', response.rows?.length || 0);
    const activeUsers = response.rows?.[0]?.metricValues?.[0]?.value || '0';
    console.log('Active Users:', activeUsers);

    // Cache the result
    cache.set('activeUsers', activeUsers);

    res.send(activeUsers);
  } catch (error) {
    console.error('Error Message:', error.message);
    console.error('Full Error:', error);
    res.send('0');
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
});
