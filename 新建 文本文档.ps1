powershell -ExecutionPolicy Bypass -File .\easytier-test.ps1 -Role guest `
  -Peer 10.144.144.1 -NetworkName dango-test-9f3a -NetworkSecret k7Xq2p `
  -Ip 10.144.144.2 -Connect udp://220.205.16.32:11010