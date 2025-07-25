
'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import type { Peer, DataConnection } from 'peerjs';
import { type GameState, type Player } from '@/lib/game';
import { useToast } from './use-toast';
import { generateRoomCode } from '@/lib/roomCodeGenerator';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type PlayerRole = 'host' | 'peer' | 'none';

type Message = {
    type: 'game_state_update';
    payload: GameState;
} | {
    type: 'player_join_request';
    payload: { peerId: string, playerName: string };
} | {
    type: 'game_full';
} | {
    type: 'welcome';
    payload: GameState;
};

export const useGameConnection = (localPlayerName: string) => {
    const [myPeerId, setMyPeerId] = useState<string>('');
    const [status, setStatus] = useState<ConnectionStatus>('disconnected');
    const [role, setRole] = useState<PlayerRole>('none');
    const [gameState, setGameState] = useState<GameState | null>(null);
    const { toast } = useToast();

    // Refs for PeerJS instance and current game state to avoid stale closures
    const peerRef = useRef<Peer | null>(null);
    const gameStateRef = useRef(gameState);
    const connectionsRef = useRef<Record<string, DataConnection>>({});

    useEffect(() => { gameStateRef.current = gameState; }, [gameState]);

    const handleIncomingMessage = (message: Message, fromPeerId: string) => {
        console.log('Received message:', message.type, 'from', fromPeerId);
        switch (message.type) {
            case 'game_state_update':
                // Only peers should accept state updates from the host
                if (role === 'peer') {
                    setGameState(message.payload);
                }
                break;
            case 'player_join_request':
                if (role === 'host' && gameStateRef.current) {
                    const currentGameState = gameStateRef.current;
                    if (currentGameState.players.length >= currentGameState.playerCount) {
                        connectionsRef.current[fromPeerId]?.send({ type: 'game_full' });
                        return;
                    }

                    const newPlayer: Player = {
                        id: currentGameState.players.length,
                        peerId: message.payload.peerId,
                        name: message.payload.playerName,
                        hand: [], isBidder: false, isPartner: false, collectedCards: [], tricksWon: 0
                    };
                    
                    const newGameState = {
                        ...currentGameState,
                        players: [...currentGameState.players, newPlayer],
                        turnHistory: [...currentGameState.turnHistory, `${newPlayer.name} has joined.`]
                    };

                    // Welcome the new player with the full state
                    connectionsRef.current[fromPeerId]?.send({ type: 'welcome', payload: newGameState });
                    
                    // Notify all other players
                    broadcastGameState(newGameState);
                }
                break;
            case 'welcome':
                // For a peer who has just joined
                setGameState(message.payload);
                break;
            case 'game_full':
                toast({ variant: 'destructive', title: 'Game is full', description: 'Could not join the game because it is full.' });
                setRole('none');
                break;
        }
    };

    const initializePeer = useCallback(() => {
        // Dynamically import PeerJS only on the client side
        import('peerjs').then(({ default: Peer }) => {
            if (peerRef.current) {
                peerRef.current.destroy();
            }

            const newPeer = new Peer();
            peerRef.current = newPeer;
            setStatus('connecting');

            newPeer.on('open', (id) => {
                setMyPeerId(id);
                setStatus('connected');
                console.log('My peer ID is: ' + id);
            });

            newPeer.on('connection', (conn) => {
                console.log(`Incoming connection from ${conn.peer}`);
                connectionsRef.current[conn.peer] = conn;
                conn.on('open', () => {
                    conn.on('data', (data) => handleIncomingMessage(data as Message, conn.peer));
                    conn.on('close', () => {
                         console.log(`Connection closed from ${conn.peer}`);
                         // A real implementation would handle player disconnects here by removing them from game state and broadcasting.
                         if (role === 'host' && gameStateRef.current) {
                            const newPlayers = gameStateRef.current.players.filter(p => p.peerId !== conn.peer);
                            if (newPlayers.length < gameStateRef.current.players.length) {
                                const newGameState = {
                                    ...gameStateRef.current,
                                    players: newPlayers,
                                    turnHistory: [...gameStateRef.current.turnHistory, `A player has disconnected.`]
                                };
                                broadcastGameState(newGameState);
                            }
                         }
                         delete connectionsRef.current[conn.peer];
                    });
                });
            });

            newPeer.on('error', (err: any) => {
                console.error('PeerJS error:', err);
                if (err.type === 'peer-unavailable') {
                    toast({ variant: 'destructive', title: 'Could Not Join', description: 'The host is not available. Please check the game code and try again.' });
                    setRole('none');
                    setGameState(null);
                } else {
                    toast({ variant: 'destructive', title: 'Connection Error', description: 'A network error occurred.' });
                }
                setStatus('error');
            });
        });
    }, [toast]);

    useEffect(() => {
        initializePeer();
        return () => {
            peerRef.current?.destroy();
        };
    }, [initializePeer]);
    
    const hostGame = async (initialState: GameState) => {
        if (!myPeerId) {
            toast({ variant: 'destructive', title: 'Error', description: 'Could not get a peer ID to host.'});
            return;
        }
        
        setRole('host');
        const roomCode = generateRoomCode();
        setGameState({ ...initialState, id: roomCode, hostPeerId: myPeerId });
    };

    const joinGame = async (hostPeerId: string) => {
        if (!peerRef.current || !myPeerId) {
            toast({ variant: 'destructive', title: 'Connection not ready', description: 'Please wait a moment and try again.'});
            return;
        }
        
        console.log(`Attempting to connect to host: ${hostPeerId}`);
        const conn = peerRef.current.connect(hostPeerId, { reliable: true });
        setRole('peer');

        conn.on('open', () => {
            connectionsRef.current[hostPeerId] = conn;
            console.log(`Connection opened to host ${hostPeerId}`);
            // Announce presence to host
            conn.send({ type: 'player_join_request', payload: { peerId: myPeerId, playerName: localPlayerName } });
        });
        
        conn.on('data', (data) => handleIncomingMessage(data as Message, hostPeerId));

        conn.on('error', (err) => {
            console.error('Connection error:', err);
            toast({ variant: 'destructive', title: 'Failed to Join', description: 'Could not connect to the host.' });
            setRole('none');
        });
    };
    
    const broadcastGameState = (newState: GameState) => {
        if (role !== 'host') return;
        console.log("Host broadcasting state:", newState);
        Object.values(connectionsRef.current).forEach(conn => {
            if (conn && conn.open) {
                conn.send({ type: 'game_state_update', payload: newState });
            }
        });
        // The host also updates its own state
        setGameState(newState);
    };
    
    return { myPeerId, status, role, gameState, hostGame, joinGame, broadcastGameState };
};
