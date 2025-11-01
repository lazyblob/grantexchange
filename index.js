const express = require('express');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const app = express();
const port = process.env.PORT || 8080;

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
    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [{ startDate: '1daysAgo', endDate: 'today' }],  // Shorter for testing
      metrics: [{ name: 'totalUsers' }],
    });
    console.log('Response rows:', response.rows?.length || 0);
    const totalUsers = response.rows?.[0]?.metricValues?.[0]?.value || '0';
    console.log('Total Users:', totalUsers);
    res.send(totalUsers);
  } catch (error) {
    console.error('Error Message:', error.message);
    console.error('Full Error:', error);
    res.send('0');
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
});
