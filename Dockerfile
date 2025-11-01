FROM node:20

# Copy app files
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Expose port and start app
EXPOSE 8080
CMD ["npm", "start"]
